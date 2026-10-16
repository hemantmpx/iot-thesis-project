#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "..", "iot", "pi", "node_modules", "ethers"));
const solc = require(path.join(__dirname, "..", "iot", "pi", "node_modules", "solc"));

const ROOT = path.resolve(__dirname, "..");
const TMP_DIR = path.join(ROOT, "tmp");
const ABI_ARTIFACT_DIR = path.join(ROOT, "iot", "abis");
const LEGACY_ARTIFACT_DIR = path.join(ROOT, "informational", "contracts", "artifacts");
const SOURCE_DIR = path.join(ROOT, "informational", "contracts");
const NODE_MODULES_DIR = path.join(ROOT, "iot", "pi", "node_modules");
const FORCE_SOURCE_ARTIFACTS = new Set(["TableAccessControlContract"]);
const DEPLOYED_PATH = path.join(TMP_DIR, "deployed-addresses.json");
const KEYS_PATH = path.join(TMP_DIR, "ganache-keys.json");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveImportPath(importPath) {
  const candidates = [
    path.join(SOURCE_DIR, importPath),
    path.join(NODE_MODULES_DIR, importPath),
    path.join(SOURCE_DIR, path.basename(importPath)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function compileSourceArtifact(name) {
  const sourcePath = path.join(SOURCE_DIR, `${name}.sol`);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found for ${name}: ${sourcePath}`);
  }

  const sourceName = `${name}.sol`;
  const input = {
    language: "Solidity",
    sources: {
      [sourceName]: {
        content: fs.readFileSync(sourcePath, "utf8"),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Ganache in this evaluation stack executes the rest of the thesis artifacts
      // correctly with a pre-Shanghai target. TAC compiled for Shanghai was emitting
      // bytecode that failed at runtime and showed up as artificial out-of-gas rows.
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (importPath) => {
      const resolved = resolveImportPath(importPath);
      if (!resolved) {
        return { error: `File not found: ${importPath}` };
      }
      return { contents: fs.readFileSync(resolved, "utf8") };
    },
  }));

  if (output.errors) {
    const fatal = output.errors.filter((err) => err.severity === "error");
    if (fatal.length) {
      throw new Error(`Failed compiling ${name}: ${fatal.map((err) => err.formattedMessage).join("\n")}`);
    }
  }

  const contract = output.contracts?.[sourceName]?.[name];
  const abi = contract?.abi;
  const bytecode = contract?.evm?.bytecode?.object || null;
  if (!abi || !bytecode) {
    throw new Error(`Compiled artifact for ${name} is missing abi or bytecode`);
  }
  return { abi, bytecode };
}

function loadArtifact(name) {
  if (FORCE_SOURCE_ARTIFACTS.has(name)) {
    return compileSourceArtifact(name);
  }

  const artifactPaths = [
    path.join(ABI_ARTIFACT_DIR, `${name}.json`),
    path.join(LEGACY_ARTIFACT_DIR, `${name}.json`),
  ];

  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) continue;
    const artifact = loadJson(artifactPath);
    const abi = artifact.abi;
    const bytecode = artifact?.data?.bytecode?.object || artifact?.bytecode || null;
    if (abi && bytecode) {
      return { abi, bytecode };
    }
  }

  return compileSourceArtifact(name);
}

function compileMinimalJudgeArtifact() {
  const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRoleBasedAccessControl {
    function getRole(address account) external view returns (uint8);
    function updateMemberStatus(address member, string memory newStatus) external;
    function penalizeMember(address member, uint256 amount) external;
    function rewardMember(address member, uint256 amount) external;
}

contract JudgeContract {
    IRoleBasedAccessControl public roleBasedAccessContract;
    address public admin;

    struct MisbehaviorRecord {
        uint256 blockingEndTime;
    }

    mapping(address => MisbehaviorRecord) public misbehaviorHistory;

    constructor(address initialAdmin, address _roleBasedAccessContract) {
        admin = initialAdmin;
        roleBasedAccessContract = IRoleBasedAccessControl(_roleBasedAccessContract);
    }

    modifier onlyAdmin() {
        require(roleBasedAccessContract.getRole(msg.sender) == 1, "Access denied: Not an Admin");
        _;
    }

    function reportMaliciousActivity(address member, string memory reason)
        external
        onlyAdmin
        returns (uint256 penaltyAmount, string memory reasonString, uint256 blockingEndTime)
    {
        bytes32 reasonHash = keccak256(bytes(reason));
        uint256 duration = 0;
        string memory status = "SUSPICIOUS";
        uint256 penalty = 1000;

        if (reasonHash == keccak256(bytes("Unauthorized access attempt"))) {
            duration = 1 hours;
            status = "MALICIOUS";
            penalty = 5000;
        } else if (reasonHash == keccak256(bytes("Too frequent access"))) {
            duration = 30 minutes;
            status = "SUSPICIOUS";
            penalty = 1000;
        } else if (reasonHash == keccak256(bytes("Tampering with data"))) {
            duration = 3 hours;
            status = "MALICIOUS";
            penalty = 8000;
        } else if (reasonHash == keccak256(bytes("Privilege escalation"))) {
            duration = 5 hours;
            status = "MALICIOUS";
            penalty = 10000;
        } else if (reasonHash == keccak256(bytes("Denial of Service"))) {
            duration = 2 days;
            status = "MALICIOUS";
            penalty = 20000;
        }

        roleBasedAccessContract.updateMemberStatus(member, status);
        if (penalty > 0) {
            try roleBasedAccessContract.penalizeMember(member, penalty) {} catch {}
        }

        misbehaviorHistory[member].blockingEndTime = block.timestamp + duration;
        return (penalty, reason, misbehaviorHistory[member].blockingEndTime);
    }

    function reportNonPenalizeMisbehavior(address member)
        external
        onlyAdmin
        returns (uint256 rewardAmount, string memory newStatus)
    {
        member;
        return (0, "not changed");
    }

    function getBlockingEndTime(address member) external view returns (uint256) {
        return misbehaviorHistory[member].blockingEndTime;
    }
}
`;

  const input = {
    language: "Solidity",
    sources: {
      "JudgeContract.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    const fatal = output.errors.filter((err) => err.severity === "error");
    if (fatal.length) {
      throw new Error(`Minimal judge compile failed: ${fatal.map((err) => err.formattedMessage).join("\n")}`);
    }
  }
  const contract = output.contracts["JudgeContract.sol"].JudgeContract;
  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object,
  };
}

function getArg(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return defaultValue;
}

async function waitForRpc(provider, attempts = 30, delayMs = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await provider.getBlockNumber();
      return;
    } catch (_err) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`RPC did not become ready after ${attempts} attempts`);
}

async function deployContract(name, signer, args, overrides = {}) {
  const { abi, bytecode } = loadArtifact(name);
  return deployFromArtifact(name, signer, { abi, bytecode }, args, overrides);
}

async function deployFromArtifact(name, signer, artifact, args, overrides = {}) {
  const { abi, bytecode } = artifact;
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  console.log(`Deploying ${name}...`);
  const contract = await factory.deploy(...args, overrides);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`Deployed ${name}: ${address}`);
  return new ethers.Contract(address, abi, signer);
}

async function assignAdminRole(roleToken, adminWallet, targetAddress, label) {
  const adminAddress = await adminWallet.getAddress();
  const roleVal = await roleToken.getRole(targetAddress);
  if (String(roleVal) === "1") return;
  const tx = await roleToken.connect(adminWallet).assignAdminRole(adminAddress, targetAddress);
  await tx.wait();
  console.log(`Assigned admin role to ${label}: ${targetAddress}`);
}

async function main() {
  const rpcUrl = getArg("--rpc-url", "http://127.0.0.1:8545");
  const keys = loadJson(KEYS_PATH);
  const ownerAddress = Object.keys(keys.private_keys)[0];
  const ownerPk = keys.private_keys[ownerAddress.toLowerCase()] || keys.private_keys[ownerAddress];
  if (!ownerPk) {
    throw new Error(`Owner private key for ${ownerAddress} not found in ${KEYS_PATH}`);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  await waitForRpc(provider);

  const adminWallet = new ethers.Wallet(ownerPk, provider);
  const adminSigner = new ethers.NonceManager(adminWallet);
  const adminAddress = await adminSigner.getAddress();
  const chainId = await provider.send("eth_chainId", []);
  console.log(`Bootstrapping contracts on ${rpcUrl} with admin ${adminAddress} (chain ${chainId})`);

  const deployOverrides = { gasLimit: 25_000_000n };

  const roleToken = await deployContract("RoleToken", adminSigner, [adminAddress], deployOverrides);
  const roleBased = await deployContract("RoleBasedAccessControl", adminSigner, [
    await roleToken.getAddress(),
    adminAddress,
  ], deployOverrides);
  await assignAdminRole(roleToken, adminSigner, await roleBased.getAddress(), "RoleBasedAccessControl");

  const register = await deployContract("RegisterContract", adminSigner, [
    adminAddress,
    await roleBased.getAddress(),
  ], deployOverrides);
  await assignAdminRole(roleToken, adminSigner, await register.getAddress(), "RegisterContract");
  let judge;
  try {
    judge = await deployContract("JudgeContract", adminSigner, [
      adminAddress,
      await roleBased.getAddress(),
    ], deployOverrides);
  } catch (err) {
    console.log(`Primary JudgeContract deployment failed: ${err.message || err}`);
    const minimalJudge = compileMinimalJudgeArtifact();
    judge = await deployFromArtifact("JudgeContractMinimal", adminSigner, minimalJudge, [
      adminAddress,
      await roleBased.getAddress(),
    ], deployOverrides);
  }
  await assignAdminRole(roleToken, adminSigner, await judge.getAddress(), "JudgeContract");

  const accessFactory = await deployContract("AccessControlFactory", adminSigner, [
    adminAddress,
    await roleBased.getAddress(),
    await register.getAddress(),
    await judge.getAddress(),
  ], deployOverrides);
  await assignAdminRole(roleToken, adminSigner, await accessFactory.getAddress(), "AccessControlFactory");

  const setJudgeTx = await register.connect(adminSigner).setJudgeContractAddress(await judge.getAddress());
  await setJudgeTx.wait();

  const tac = await deployContract("TableAccessControlContract", adminSigner, [
    await roleBased.getAddress(),
    await judge.getAddress(),
    await register.getAddress(),
    adminAddress,
  ], deployOverrides);
  await assignAdminRole(roleToken, adminSigner, await tac.getAddress(), "TableAccessControlContract");

  const deployed = {
    network: "development",
    deployedAt: new Date().toISOString(),
    addresses: {
      roleToken: await roleToken.getAddress(),
      roleBasedAccessControl: await roleBased.getAddress(),
      registerContract: await register.getAddress(),
      judgeContract: await judge.getAddress(),
      accessControlFactory: await accessFactory.getAddress(),
      tableAccessControlContract: await tac.getAddress(),
    },
  };

  fs.writeFileSync(DEPLOYED_PATH, `${JSON.stringify(deployed, null, 2)}\n`);
  console.log(JSON.stringify(deployed, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
