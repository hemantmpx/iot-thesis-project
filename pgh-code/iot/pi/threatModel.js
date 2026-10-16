const fs = require("fs");
const path = require("path");

const securityMatrixPath = path.join(__dirname, "..", "..", "config", "securityMatrix.json");
const threatCatalogPath = path.join(__dirname, "..", "..", "config", "threatCatalog.json");

const securityMatrix = JSON.parse(fs.readFileSync(securityMatrixPath, "utf8"));
const threatCatalog = JSON.parse(fs.readFileSync(threatCatalogPath, "utf8"));

const TAMPER_ACTIONS = new Set(["edit", "delete", "create"]);
const DEFAULT_SECURITY_BUDGET = 100;

function normalizeRole(roleEnumValue) {
  if (typeof roleEnumValue === "string") {
    const trimmed = roleEnumValue.trim();
    if (/^\d+$/.test(trimmed)) {
      return normalizeRole(Number(trimmed));
    }
    return trimmed.toUpperCase();
  }

  const numericRole = Number(roleEnumValue);
  if (!Number.isNaN(numericRole)) {
    switch (numericRole) {
      case 1:
        return "ADMIN";
      case 2:
        return "PRIMARY_GROUP_HEAD";
      case 3:
        return "SECONDARY_GROUP_HEAD";
      case 4:
        return "REGULAR_MEMBER";
      default:
        return "UNKNOWN";
    }
  }

  return "UNKNOWN";
}

function getRolePermissions(roleName) {
  return securityMatrix.roles[roleName];
}

function findThreatByCode(code) {
  return threatCatalog.events.find((event) => event.code === code);
}

async function getSubjectRole(roleBasedContract, subjectAddress) {
  try {
    const role = await roleBasedContract.getRole(subjectAddress);
    return normalizeRole(role?.toString?.() ?? role);
  } catch (_err) {
    return "UNKNOWN";
  }
}

function evaluateAccessAgainstMatrix({ roleName, context, action }) {
  const permissions = getRolePermissions(roleName);
  if (!permissions) {
    return { allowed: false, reason: "UNKNOWN_ROLE" };
  }

  const allowedActions = permissions[context];
  if (!Array.isArray(allowedActions)) {
    return { allowed: false, reason: "UNKNOWN_CONTEXT" };
  }

  const allowed = allowedActions.includes(action);
  return { allowed, reason: allowed ? "PERMITTED" : "STRIDE_TRIGGER_UNAUTHORIZED_ACCESS" };
}

function toNumber(value, fallback = 0) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string" && value.length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function dedupeFindings(findings) {
  return findings.filter(Boolean).reduce((acc, threat) => {
    if (!acc.some((existing) => existing.code === threat.code)) {
      acc.push(threat);
    }
    return acc;
  }, []);
}

class ThreatEngine {
  constructor({ roleBasedContract, judgeContract = null, provider = null }) {
    this.roleBasedContract = roleBasedContract;
    this.judgeContract = judgeContract;
    this.provider = provider;
    this.attemptCounters = new Map();
    this.gatewayQuarantine = new Map();
    this.attemptWindowSeconds = 60;
    this.maxAttemptsPerWindow = 5;
  }

  _subjectKey(subjectAddress) {
    return String(subjectAddress || "").toLowerCase();
  }

  async getChainTimestamp() {
    if (this.provider?.getBlock) {
      try {
        const latestBlock = await this.provider.getBlock("latest");
        if (latestBlock?.timestamp !== undefined && latestBlock?.timestamp !== null) {
          return toNumber(latestBlock.timestamp, Math.floor(Date.now() / 1000));
        }
      } catch (_err) {
        // fall back to wall-clock time if the provider is temporarily unavailable
      }
    }
    return Math.floor(Date.now() / 1000);
  }

  async getRoleName(address) {
    return getSubjectRole(this.roleBasedContract, address);
  }

  _getAttemptBucket(subjectAddress, nowSeconds) {
    const key = this._subjectKey(subjectAddress);
    if (!this.attemptCounters.has(key)) {
      this.attemptCounters.set(key, []);
    }

    const bucket = this.attemptCounters.get(key);
    const filtered = bucket.filter((timestamp) => nowSeconds - timestamp < this.attemptWindowSeconds);
    this.attemptCounters.set(key, filtered);
    return filtered;
  }

  recordAttempt(subjectAddress, nowSeconds) {
    const bucket = this._getAttemptBucket(subjectAddress, nowSeconds);
    bucket.push(nowSeconds);
    return bucket.length;
  }

  clearAttempts(subjectAddress) {
    this.attemptCounters.set(this._subjectKey(subjectAddress), []);
  }

  getGatewayQuarantineState(subjectAddress, nowSeconds = Math.floor(Date.now() / 1000)) {
    const key = this._subjectKey(subjectAddress);
    const entry = this.gatewayQuarantine.get(key);
    if (!entry) {
      return null;
    }

    if (!entry.permanentRevoked && entry.quarantineUntil && nowSeconds >= entry.quarantineUntil) {
      this.gatewayQuarantine.delete(key);
      return null;
    }

    return entry;
  }

  syncGatewayQuarantine(subjectAddress, judgeState, metadata = {}) {
    const key = this._subjectKey(subjectAddress);
    if (!key) {
      return null;
    }

    if (!judgeState) {
      return this.gatewayQuarantine.get(key) || null;
    }

    const entry = {
      subjectAddress,
      permanentRevoked: Boolean(judgeState.permanentRevoked),
      quarantineUntil: toNumber(judgeState.quarantineUntil),
      waveIndex: toNumber(judgeState.waveIndex),
      blockedAttemptCountInWave: toNumber(judgeState.blockedAttemptCountInWave),
      securityTokenBudget: toNumber(judgeState.securityTokenBudget, DEFAULT_SECURITY_BUDGET),
      cumulativePenalty: toNumber(judgeState.cumulativePenalty),
      lastMaliciousAt: toNumber(judgeState.lastMaliciousAt),
      lastBenignAt: toNumber(judgeState.lastBenignAt),
      source: metadata.source || "judge",
      updatedAt: metadata.updatedAt || Math.floor(Date.now() / 1000),
    };

    if (entry.permanentRevoked || entry.quarantineUntil > 0) {
      this.gatewayQuarantine.set(key, entry);
      return entry;
    }

    this.gatewayQuarantine.delete(key);
    return null;
  }

  async getMemberSecurityState(subjectAddress) {
    const defaultState = {
      waveIndex: 0,
      consecutiveMaliciousCount: 0,
      blockedAttemptCountInWave: 0,
      quarantineLevel: 0,
      quarantineUntil: 0,
      permanentRevoked: false,
      lastMaliciousAt: 0,
      lastBenignAt: 0,
      securityTokenBudget: DEFAULT_SECURITY_BUDGET,
      cumulativePenalty: 0,
      temporarilyQuarantined: false,
    };

    if (!this.judgeContract) {
      return defaultState;
    }

    try {
      if (typeof this.judgeContract.getMemberSecurityState === "function") {
        const state = await this.judgeContract.getMemberSecurityState(subjectAddress);
        const normalized = {
          waveIndex: toNumber(state.waveIndex ?? state[0]),
          consecutiveMaliciousCount: toNumber(state.consecutiveMaliciousCount ?? state[1]),
          blockedAttemptCountInWave: toNumber(state.blockedAttemptCountInWave ?? state[2]),
          quarantineLevel: toNumber(state.quarantineLevel ?? state[3]),
          quarantineUntil: toNumber(state.quarantineUntil ?? state[4]),
          permanentRevoked: Boolean(state.permanentRevoked ?? state[5]),
          lastMaliciousAt: toNumber(state.lastMaliciousAt ?? state[6]),
          lastBenignAt: toNumber(state.lastBenignAt ?? state[7]),
          securityTokenBudget: toNumber(state.securityTokenBudget ?? state[8], DEFAULT_SECURITY_BUDGET),
          cumulativePenalty: toNumber(state.cumulativePenalty ?? state[9]),
        };
        const now = await this.getChainTimestamp();
        normalized.temporarilyQuarantined = !normalized.permanentRevoked && normalized.quarantineUntil > now;
        return normalized;
      }
    } catch (_err) {
      // fall through to compatibility getters
    }

    try {
      const [quarantineUntil, permanentRevoked, securityTokenBudget, cumulativePenalty, waveIndex, blockedAttemptCountInWave, lastMaliciousAt, lastBenignAt] = await Promise.all([
        typeof this.judgeContract.getQuarantineUntil === "function"
          ? this.judgeContract.getQuarantineUntil(subjectAddress)
          : this.judgeContract.getBlockingEndTime(subjectAddress),
        typeof this.judgeContract.isPermanentlyRevoked === "function"
          ? this.judgeContract.isPermanentlyRevoked(subjectAddress)
          : false,
        typeof this.judgeContract.getSecurityTokenBudget === "function"
          ? this.judgeContract.getSecurityTokenBudget(subjectAddress)
          : DEFAULT_SECURITY_BUDGET,
        typeof this.judgeContract.getCumulativePenalty === "function"
          ? this.judgeContract.getCumulativePenalty(subjectAddress)
          : 0,
        typeof this.judgeContract.getWaveIndex === "function" ? this.judgeContract.getWaveIndex(subjectAddress) : 0,
        typeof this.judgeContract.getBlockedAttemptCount === "function"
          ? this.judgeContract.getBlockedAttemptCount(subjectAddress)
          : 0,
        typeof this.judgeContract.getLastMaliciousAt === "function"
          ? this.judgeContract.getLastMaliciousAt(subjectAddress)
          : 0,
        typeof this.judgeContract.getLastBenignAt === "function" ? this.judgeContract.getLastBenignAt(subjectAddress) : 0,
      ]);

      const now = await this.getChainTimestamp();
      return {
        ...defaultState,
        waveIndex: toNumber(waveIndex),
        blockedAttemptCountInWave: toNumber(blockedAttemptCountInWave),
        quarantineUntil: toNumber(quarantineUntil),
        permanentRevoked: Boolean(permanentRevoked),
        lastMaliciousAt: toNumber(lastMaliciousAt),
        lastBenignAt: toNumber(lastBenignAt),
        securityTokenBudget: toNumber(securityTokenBudget, DEFAULT_SECURITY_BUDGET),
        cumulativePenalty: toNumber(cumulativePenalty),
        temporarilyQuarantined: !Boolean(permanentRevoked) && toNumber(quarantineUntil) > now,
      };
    } catch (_err) {
      return defaultState;
    }
  }

  async assessRequest({
    subjectAddress,
    objectAddress,
    accType,
    resource,
    action,
    allowedByBlockchain,
    preJudgeState = null,
    postJudgeState = null,
    denialReason = null,
  }) {
    const nowSeconds = await this.getChainTimestamp();
    const roleName = await getSubjectRole(this.roleBasedContract, subjectAddress);
    const context = accType === "sensor" ? "localResourceTable" : "globalResourceTable";
    const matrixResult = evaluateAccessAgainstMatrix({ roleName, context, action });
    const attemptCount = this.recordAttempt(subjectAddress, nowSeconds);
    const tooMany = attemptCount > this.maxAttemptsPerWindow;
    const dosThreshold = this.maxAttemptsPerWindow * 3;
    const findings = [];

    if (!allowedByBlockchain) {
      findings.push(findThreatByCode("UNAUTHORIZED_ACCESS"));
    }

    if (!matrixResult.allowed && matrixResult.reason !== "PERMITTED") {
      findings.push(findThreatByCode("UNAUTHORIZED_ACCESS"));
      if (TAMPER_ACTIONS.has(action)) {
        findings.push(findThreatByCode("DATA_TAMPERING"));
      }
    }

    if (tooMany) {
      findings.push(findThreatByCode("TOO_MANY_ACCESS_ATTEMPTS"));
    }

    if (attemptCount > dosThreshold) {
      findings.push(findThreatByCode("DISRUPTION_OF_SERVICE"));
    }

    if (allowedByBlockchain) {
      const successThreat = findThreatByCode("SUCCESSFUL_ACCESS");
      if (successThreat) {
        findings.push(successThreat);
      }

      for (let i = findings.length - 1; i >= 0; i -= 1) {
        const threat = findings[i];
        if (!threat) continue;
        if (["UNAUTHORIZED_ACCESS", "TOO_MANY_ACCESS_ATTEMPTS", "DISRUPTION_OF_SERVICE"].includes(threat.code)) {
          findings.splice(i, 1);
        }
      }

      this.clearAttempts(subjectAddress);
    }

    const effectivePostState = postJudgeState || preJudgeState || null;
    if (effectivePostState) {
      this.syncGatewayQuarantine(subjectAddress, effectivePostState, {
        source: denialReason || (effectivePostState.permanentRevoked ? "permanent_containment" : "judge"),
        updatedAt: nowSeconds,
      });
    }

    return {
      roleName,
      findings: dedupeFindings(findings),
      matrixResult,
      attemptCount,
      threatWindowSeconds: this.attemptWindowSeconds,
      judgeStateBefore: preJudgeState,
      judgeStateAfter: postJudgeState,
      gatewayQuarantine: this.getGatewayQuarantineState(subjectAddress, nowSeconds),
      requestTimestamp: nowSeconds,
      context: {
        subjectAddress,
        objectAddress,
        resource,
        action,
      },
    };
  }

  async assessRegistration({ deviceAddress, existingRole }) {
    const findings = [];
    if (existingRole && existingRole !== "UNKNOWN") {
      const threat = findThreatByCode("MISREPRESENTATION_OF_IDENTITY");
      if (threat) {
        findings.push(threat);
      }
    }

    return {
      findings,
      deviceAddress,
    };
  }
}

module.exports = {
  ThreatEngine,
  getRolePermissions,
  findThreatByCode,
  normalizeRole,
};
