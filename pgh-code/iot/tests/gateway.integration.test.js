const request = require("supertest");
const { createGatewayApp, ZERO_ADDRESS } = require("../pi/primary_head");

const DEFAULT_TX_HASH = "0xdeadbeef";

function createStubReceipt(hash = DEFAULT_TX_HASH) {
  return {
    hash,
    logs: [],
  };
}

function createStubTx(hash = DEFAULT_TX_HASH) {
  return {
    async wait() {
      return createStubReceipt(hash);
    },
  };
}

class StubRoleBased {
  constructor() {
    this.calls = [];
  }

  async assignRole(deviceAddress, name, memberType) {
    this.calls.push({ deviceAddress, name, memberType });
    return createStubTx("0xregister");
  }
}

class StubRegisterContract {
  constructor() {
    this.registry = new Map();
  }

  _key(objectAddress, subjectAddress, accType) {
    return `${objectAddress}:${subjectAddress}:${accType}`;
  }

  register(objectAddress, subjectAddress, accType, contractAddress) {
    this.registry.set(this._key(objectAddress, subjectAddress, accType), contractAddress);
  }

  async getAccessControlContract(objectAddress, subjectAddress, accType) {
    return this.registry.get(this._key(objectAddress, subjectAddress, accType)) || ZERO_ADDRESS;
  }
}

class StubAccessContract {
  constructor(address, decisionMap) {
    this.address = address;
    this.decisionMap = decisionMap;
    this.policies = [];

    this.interface = {
      encodeFunctionData: (_fn, [resource, action]) =>
        JSON.stringify({ address: this.address, resource, action }),
      decodeFunctionResult: (_fn, response) => {
        const payload = JSON.parse(response);
        return [payload.allowed];
      },
    };
  }

  async policyAdd(resource, action, permission) {
    this.policies.push({ resource, action, permission });
    const allowed = permission.toLowerCase() === "allow";
    this.decisionMap.set(`${this.address}:${resource}:${action}`, allowed);
    return createStubTx("0xpolicy");
  }
}

class StubAccessFactory {
  constructor(registerContract, accessContractStore, decisionMap) {
    this.registerContract = registerContract;
    this.accessContractStore = accessContractStore;
    this.decisionMap = decisionMap;
    this.counter = 1;
  }

  async deployAccessControlContract(objectAddress, subjectAddress, accType) {
    const addressHex = this.counter.toString(16).padStart(40, "0");
    const contractAddress = `0x${addressHex}`;
    const contract = new StubAccessContract(contractAddress, this.decisionMap);
    this.accessContractStore.set(contractAddress, contract);
    this.registerContract.register(objectAddress, subjectAddress, accType, contractAddress);
    this.counter += 1;
    return createStubTx("0xdeploy");
  }
}

function setupGateway() {
  const decisionMap = new Map();
  const accessContracts = new Map();
  const roleBased = new StubRoleBased();
  const registerContract = new StubRegisterContract();
  const accessFactory = new StubAccessFactory(registerContract, accessContracts, decisionMap);

  const provider = {
    async call({ to, data }) {
      const payload = JSON.parse(data);
      const key = `${to}:${payload.resource}:${payload.action}`;
      const allowed = decisionMap.get(key) ?? false;
      return JSON.stringify({ allowed });
    },
  };

  const loadAccessContract = async (address) => {
    const contract = accessContracts.get(address);
    if (!contract) {
      throw new Error(`Unknown access contract for ${address}`);
    }
    return contract;
  };

  const app = createGatewayApp({
    roleBased,
    accessFactory,
    registerContract,
    loadAccessContract,
    provider,
  });

  return {
    app,
    roleBased,
    registerContract,
  };
}

describe("Gateway integration (stubbed blockchain)", () => {
  const OBJECT = "0xobject000000000000000000000000000000000001";
  const SUBJECT = "0xsubject0000000000000000000000000000000002";
  const MEMBER = "0xmember000000000000000000000000000000000003";
  const ACC_TYPE = "temperature";

  it("registers a device and records the role assignment", async () => {
    const { app, roleBased } = setupGateway();

    await request(app)
      .post("/register-device")
      .send({ deviceAddress: MEMBER, name: "device-1", memberType: "typeA" })
      .expect(200)
      .expect((res) => {
        if (res.body.status !== "ok") {
          throw new Error("Expected status ok");
        }
      });

    if (roleBased.calls.length !== 1) {
      throw new Error("assignRole should be called once");
    }
  });

  it("deploys an access control contract and returns its address", async () => {
    const { app, registerContract } = setupGateway();

    const res = await request(app)
      .post("/deploy-contract")
      .send({ objectAddress: OBJECT, subjectAddress: SUBJECT, accType: ACC_TYPE })
      .expect(200);

    if (!res.body.contractAddress || res.body.contractAddress === ZERO_ADDRESS) {
      throw new Error("Expected a contract address in response");
    }

    const stored = await registerContract.getAccessControlContract(OBJECT, SUBJECT, ACC_TYPE);
    if (stored !== res.body.contractAddress) {
      throw new Error("Contract address was not registered");
    }
  });

  it("adds a policy and evaluates access decisions", async () => {
    const { app } = setupGateway();

    const deployRes = await request(app)
      .post("/deploy-contract")
      .send({ objectAddress: OBJECT, subjectAddress: SUBJECT, accType: ACC_TYPE })
      .expect(200);

    const contractAddress = deployRes.body.contractAddress;

    await request(app)
      .post("/policies")
      .send({
        objectAddress: OBJECT,
        subjectAddress: SUBJECT,
        accType: ACC_TYPE,
        resource: "sensor/temperature",
        action: "view",
        permission: "allow",
      })
      .expect(200);

    const allowRes = await request(app)
      .post("/evaluate-access")
      .send({
        objectAddress: OBJECT,
        subjectAddress: SUBJECT,
        accType: ACC_TYPE,
        resource: "sensor/temperature",
        action: "view",
      })
      .expect(200);

    if (allowRes.body.allowed !== true) {
      throw new Error("Expected allow decision");
    }

    const denyRes = await request(app)
      .post("/evaluate-access")
      .send({
        objectAddress: OBJECT,
        subjectAddress: SUBJECT,
        accType: ACC_TYPE,
        resource: "sensor/temperature",
        action: "edit",
      })
      .expect(200);

    if (denyRes.body.allowed !== false) {
      throw new Error("Expected deny decision for missing policy");
    }

    if (!contractAddress) {
      throw new Error("Contract address should be set after deployment");
    }
  });

  it("rejects policy operations when no contract is registered", async () => {
    const { app } = setupGateway();

    await request(app)
      .post("/policies")
      .send({
        objectAddress: OBJECT,
        subjectAddress: SUBJECT,
        accType: ACC_TYPE,
        resource: "sensor/humidity",
        action: "view",
        permission: "allow",
      })
      .expect(404);
  });
});
