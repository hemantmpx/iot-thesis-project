const DEFAULT_ACC_TYPE = "sensor";
const DEFAULT_RESOURCE = "sensor/temp";

const SCENARIO_GROUP = {
  NORMAL: "normal",
  TIMING: "timing",
  THREAT: "threat",
  SCALABILITY: "scalability",
};

function maybeStripSetup(operations, includeSetup) {
  if (includeSetup) return operations;
  return operations.filter((op) => !op.setup);
}

function range(count) {
  return Array.from({ length: count }, (_value, index) => index + 1);
}

function roleAssignments(entries, stage = "identity_bootstrap") {
  return entries.map((entry) => ({
    op: "Role Assignment",
    setup: true,
    stage,
    behavior: "benign",
    actor: entry.actor,
    memberType: entry.memberType || "type1",
  }));
}

function buildThreatDuringAfterScenarios() {
  return [
    {
      id: "threat_during_after_privilege_escalation_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Privilege-escalation study with approved global-table access abused during the attack, followed by on-chain recovery actions.",
      operations: [
        ...roleAssignments([
          { actor: "object", memberType: "type1" },
          { actor: "subject", memberType: "type1" },
          { actor: "regular_local", memberType: "type1" },
          { actor: "primary2", memberType: "privilege_primary_b_{scenario_tag}" },
          { actor: "attacker_global", memberType: "privilege_attacker_{scenario_tag}" },
        ]),
        { op: "Register Set Judge Contract", setup: true, stage: "attack_setup", behavior: "benign" },
        { op: "Policy Add", setup: true, stage: "attack_setup", behavior: "benign", objectKey: "object", subjectKey: "subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Contract Set Judge", setup: true, stage: "attack_setup", behavior: "benign", objectKey: "object", subjectKey: "subject" },
        { op: "Create Table Access Request", stage: "during_attack_prepare", behavior: "benign", scope: "global", resource: "GlobalResourceTable", action: "edit", requesterKey: "attacker_global", approverKeys: ["object", "primary2"] },
        { op: "Create Table Access Request", stage: "during_attack_prepare", behavior: "benign", scope: "global", resource: "GlobalResourceTable", action: "delete", requesterKey: "attacker_global", approverKeys: ["object", "primary2"] },
        { op: "Table Edit Global Resource", stage: "during_attack", behavior: "malicious", scope: "global", requesterKey: "attacker_global", account1Key: "subject", account2Key: "regular_local" },
        { op: "Table Delete Global Resource", stage: "during_attack", behavior: "malicious", scope: "global", requesterKey: "attacker_global", targetAccountKey: "subject" },
        { op: "Access Contract Set Judge", stage: "during_attack", behavior: "malicious", actorKey: "attacker_global", objectKey: "object", subjectKey: "subject" },
        { op: "Role Swap", stage: "during_attack", behavior: "malicious", actorKey: "attacker_global", account1Key: "subject", account2Key: "regular_local" },
        { op: "Role Status Update", stage: "post_attack_recovery", behavior: "benign", targetKey: "attacker_global", status: "MALICIOUS" },
        { op: "Role Penalize", stage: "post_attack_recovery", behavior: "benign", targetKey: "attacker_global", amount: 1 },
        { op: "Role Revoke", stage: "post_attack_recovery", behavior: "benign", targetKey: "attacker_global" },
        { op: "Register Set Judge Contract", stage: "post_attack_recovery", behavior: "benign" },
        { op: "Access Contract Set Judge", stage: "post_attack_recovery", behavior: "benign", objectKey: "object", subjectKey: "subject" },
        { op: "Access Control without Misbehavior", stage: "post_attack_validation", behavior: "benign", objectKey: "object", subjectKey: "subject", resource: DEFAULT_RESOURCE, action: "view" },
      ],
    },
    {
      id: "threat_during_after_unauthorized_access_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_pgh",
      deterministic: true,
      description: "Cross-PGH unauthorized-access study with explicit attacker traffic, on-chain logging, and recovery via role restriction.",
      operations: [
        ...roleAssignments([
          { actor: "pghA_object", memberType: "cross_group_shared_{scenario_tag}" },
          { actor: "pghB_subject", memberType: "cross_group_shared_{scenario_tag}" },
          { actor: "pghB_attacker", memberType: "cross_group_shared_{scenario_tag}" },
        ]),
        { op: "Policy Add", setup: true, stage: "attack_setup", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control with Misbehavior", stage: "during_attack", behavior: "malicious", target: "A", objectKey: "pghA_object", subjectKey: "pghB_attacker", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Create Table Access Request with Misbehavior", stage: "during_attack", behavior: "malicious", scope: "global", resource: "GlobalResourceTable", action: "view", requesterKey: "pghB_attacker" },
        { op: "Role Status Update", stage: "post_attack_recovery", behavior: "benign", targetKey: "pghB_attacker", status: "MALICIOUS" },
        { op: "Role Penalize", stage: "post_attack_recovery", behavior: "benign", targetKey: "pghB_attacker", amount: 1 },
        { op: "Role Revoke", stage: "post_attack_recovery", behavior: "benign", targetKey: "pghB_attacker" },
        { op: "Access Control without Misbehavior", stage: "post_attack_validation", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Access Control with Misbehavior", stage: "post_attack_validation", behavior: "malicious", target: "A", objectKey: "pghA_object", subjectKey: "pghB_attacker", resource: DEFAULT_RESOURCE, action: "view" },
      ],
    },
    {
      id: "threat_during_after_tampering_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Tampering study with malicious policy and table mutation attempts, followed by on-chain restoration and actor revocation.",
      operations: [
        ...roleAssignments([
          { actor: "object", memberType: "type1" },
          { actor: "subject", memberType: "type1" },
          { actor: "regular_local", memberType: "type1" },
          { actor: "tamperer", memberType: "type1" },
        ]),
        { op: "Policy Add", setup: true, stage: "attack_setup", behavior: "benign", objectKey: "object", subjectKey: "subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Update", stage: "during_attack", behavior: "malicious", actorKey: "tamperer", objectKey: "object", subjectKey: "subject", policyId: 0, resource: DEFAULT_RESOURCE, action: "edit", permission: "allow" },
        { op: "Policy Delete", stage: "during_attack", behavior: "malicious", actorKey: "tamperer", objectKey: "object", subjectKey: "subject", policyId: 0 },
        { op: "Access Control with Misbehavior", stage: "during_attack", behavior: "malicious", objectKey: "object", subjectKey: "tamperer", resource: DEFAULT_RESOURCE, action: "edit" },
        { op: "Create Table Access Request with Misbehavior", stage: "during_attack", behavior: "malicious", scope: "global", resource: "GlobalResourceTable", action: "edit", requesterKey: "tamperer" },
        { op: "Table Edit Local Resource", stage: "during_attack", behavior: "malicious", scope: "local", requesterKey: "tamperer", account1Key: "subject", account2Key: "regular_local" },
        { op: "Table Delete Local Resource", stage: "during_attack", behavior: "malicious", scope: "local", requesterKey: "tamperer", targetAccountKey: "subject" },
        { op: "Policy Update", stage: "post_attack_recovery", behavior: "benign", objectKey: "object", subjectKey: "subject", policyId: 0, resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Role Status Update", stage: "post_attack_recovery", behavior: "benign", targetKey: "tamperer", status: "MALICIOUS" },
        { op: "Role Penalize", stage: "post_attack_recovery", behavior: "benign", targetKey: "tamperer", amount: 1 },
        { op: "Role Revoke", stage: "post_attack_recovery", behavior: "benign", targetKey: "tamperer" },
        { op: "Access Control without Misbehavior", stage: "post_attack_validation", behavior: "benign", objectKey: "object", subjectKey: "subject", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Access Control with Misbehavior", stage: "post_attack_validation", behavior: "malicious", objectKey: "object", subjectKey: "tamperer", resource: DEFAULT_RESOURCE, action: "edit" },
      ],
    },
    {
      id: "threat_during_after_too_frequent_access_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Too-frequent-access study with repeated rapid requests by the same subject, followed by on-chain sanctioning and validation.",
      operations: [
        ...roleAssignments([
          { actor: "object", memberType: "type1" },
          { actor: "burst_actor", memberType: "type1" },
          { actor: "legit_viewer", memberType: "legit_viewer_{scenario_tag}" },
        ]),
        { op: "Policy Add", setup: true, stage: "attack_setup", behavior: "benign", objectKey: "object", subjectKey: "burst_actor", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Add", setup: true, stage: "attack_setup", behavior: "benign", objectKey: "object", subjectKey: "legit_viewer", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control with Misbehavior", stage: "during_attack", behavior: "malicious", objectKey: "object", subjectKey: "burst_actor", resource: DEFAULT_RESOURCE, action: "view", repeat: 6 },
        { op: "Role Penalize", stage: "post_attack_recovery", behavior: "benign", targetKey: "burst_actor", amount: 1 },
        { op: "Role Revoke", stage: "post_attack_recovery", behavior: "benign", targetKey: "burst_actor" },
        { op: "Access Control with Misbehavior", stage: "post_attack_validation", behavior: "malicious", objectKey: "object", subjectKey: "burst_actor", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Access Control without Misbehavior", stage: "post_attack_validation", behavior: "benign", objectKey: "object", subjectKey: "legit_viewer", resource: DEFAULT_RESOURCE, action: "view" },
      ],
    },
    {
      id: "threat_during_after_poison_ivy_esp_bridge_compromise_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      usesEspBridge: true,
      espActorKeys: ["compromised_esp", "target_esp", "helper_esp"],
      description: "PoisonIvy-style ESP bridge compromise with staged Judge penalties: a legitimate-looking ESP identity is onboarded through the bridge, performs sequential malicious access waves that trigger temporary quarantines, executes brief benign recovery between waves, and is permanently revoked by the third wave once the security-token budget crosses the containment threshold.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "sensor" },
        { op: "ESP Telemetry Bootstrap", setup: true, stage: "bridge_bootstrap", behavior: "benign", deviceKey: "target_esp" },
        { op: "ESP Telemetry Bootstrap", setup: true, stage: "bridge_bootstrap", behavior: "benign", deviceKey: "helper_esp" },
        { op: "ESP Telemetry Bootstrap", setup: true, stage: "bridge_bootstrap", behavior: "benign", deviceKey: "compromised_esp" },
        { op: "ESP Status Access without Misbehavior", stage: "implant_checkin", behavior: "benign", requestorKey: "compromised_esp", targetKey: "compromised_esp" },
        { op: "ESP Status Access with Misbehavior", stage: "lateral_probe", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp" },
        { op: "ESP Temps Access with Misbehavior", stage: "lateral_probe", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp" },
        { op: "ESP Repeated Access Burst with Misbehavior", stage: "wave1_attack", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp", maxAttempts: 4, untilJudgeState: "temporary_quarantine", pattern: ["status", "temps"] },
        { op: "ESP Status Access without Misbehavior", stage: "wave1_recovery", behavior: "benign", requestorKey: "compromised_esp", targetKey: "compromised_esp", preAdvanceSeconds: 61 },
        { op: "ESP Repeated Access Burst with Misbehavior", stage: "wave2_attack", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp", maxAttempts: 4, untilJudgeState: "temporary_quarantine", pattern: ["status", "temps"] },
        { op: "ESP Status Access without Misbehavior", stage: "wave2_recovery", behavior: "benign", requestorKey: "compromised_esp", targetKey: "compromised_esp", preAdvanceSeconds: 121 },
        { op: "ESP Repeated Access Burst with Misbehavior", stage: "wave3_attack", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp", maxAttempts: 4, untilJudgeState: "permanent_revocation", pattern: ["status", "temps"] },
        { op: "ESP Status Access after Recovery", stage: "post_revocation_validation", behavior: "malicious", requestorKey: "compromised_esp", targetKey: "target_esp" },
      ],
    },
  ];
}

function buildScalabilityScenario(requestCount) {
  const scaleTag = String(requestCount).padStart(2, "0");
  const revokeCycle = [];
  for (let index = 1; index <= requestCount; index += 1) {
    if (index > 1) {
      revokeCycle.push({
        op: "Role Assignment",
        stage: "scalability_rearm",
        behavior: "benign",
        actor: "revoke_target",
        memberType: "type1",
      });
    }
    revokeCycle.push({
      op: "Role Revoke",
      stage: "scalability_measurement",
      behavior: "benign",
      targetKey: "revoke_target",
    });
  }

  return {
    id: `scalability_grt_request_scaling_${scaleTag}_01`,
    group: SCENARIO_GROUP.SCALABILITY,
    mode: "pgh_blockchain",
    deterministic: true,
    description: `Scalability profile for Global Resource Table operations with ${requestCount} repeated requests per measured function.`,
    operations: [
      ...roleAssignments([
        { actor: "object", memberType: "type1" },
        { actor: "subject", memberType: "type1" },
        { actor: "regular_local", memberType: "type1" },
        { actor: "primary2", memberType: "scale_primary_b_{scenario_tag}" },
        { actor: "scale_viewer", memberType: "scale_viewer_{scenario_tag}" },
        { actor: "revoke_target", memberType: "type1" },
      ]),
      { op: "Create Table Access Request", stage: "scalability_measurement", behavior: "benign", scope: "global", resource: "GlobalResourceTable", action: "view", requesterKey: "scale_viewer", approverKeys: ["object", "primary2"], repeat: requestCount },
      { op: "View Global Resource Table", stage: "scalability_measurement", behavior: "benign", scope: "global", viewerKey: "scale_viewer", repeat: requestCount },
      { op: "Role Swap", stage: "scalability_measurement", behavior: "benign", account1Key: "object", account2Key: "subject", repeat: requestCount },
      ...revokeCycle,
    ],
  };
}

function buildScenarioLibrary({ includeModeB = true, includeSetup = true } = {}) {
  const all = [
    {
      id: "normal_rich_federated_success_01",
      group: SCENARIO_GROUP.NORMAL,
      mode: "pgh_pgh",
      deterministic: true,
      description: "Rich benign federated workflow across PGH A and PGH B with policy setup, cross-PGH access, and table flow.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghA_object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghA_subject", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghB_object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghB_subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", target: "B", objectKey: "pghB_object", subjectKey: "pghA_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control without Misbehavior", stage: "federated_authorization", behavior: "benign", direction: "B_to_A", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Create Table Access Request", stage: "table_validation", behavior: "benign", scope: "local", resource: "LocalResourceTable", action: "view", requesterKey: "pghA_subject", approverKeys: ["pghA_object"] },
        { op: "View Local Resource Table", stage: "table_validation", behavior: "benign", scope: "local", viewerKey: "pghA_subject" },
      ],
    },
    {
      id: "normal_rich_federated_success_02",
      group: SCENARIO_GROUP.NORMAL,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Expanded local workflow that covers additional relevant contract write paths while preserving the existing architecture.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "subject", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "regular_local", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "primary2", memberType: "type2" },
        { op: "Register Set Judge Contract", setup: true, stage: "contract_setup", behavior: "benign" },
        { op: "Policy Add", stage: "policy_setup", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Update", stage: "policy_lifecycle", behavior: "benign", policyId: 0, resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Contract Set Judge", stage: "policy_lifecycle", behavior: "benign" },
        { op: "Access Contract Deactivate", stage: "policy_lifecycle", behavior: "benign" },
        { op: "Access Contract Activate", stage: "policy_lifecycle", behavior: "benign" },
        { op: "Access Control without Misbehavior", stage: "authorization", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Policy Delete", stage: "policy_lifecycle", behavior: "benign", policyId: 0 },
        { op: "Create Table Access Request", stage: "table_validation", behavior: "benign", scope: "local", resource: "LocalResourceTable", action: "view", requesterKey: "subject", approverKeys: ["object"] },
        { op: "View Local Resource Table", stage: "table_validation", behavior: "benign", scope: "local", viewerKey: "subject" },
        { op: "Table Edit Local Resource", stage: "table_mutation", behavior: "benign", scope: "local", requesterKey: "subject", approverKeys: ["object"], account1Key: "subject", account2Key: "regular_local" },
        { op: "Table Delete Local Resource", stage: "table_mutation", behavior: "benign", scope: "local", requesterKey: "subject", approverKeys: ["object"], targetAccountKey: "regular_local" },
        { op: "Create Table Access Request", stage: "table_validation", behavior: "benign", scope: "global", resource: "GlobalResourceTable", action: "view", requesterKey: "object", approverKeys: ["primary2"] },
        { op: "View Global Resource Table", stage: "table_validation", behavior: "benign", scope: "global", viewerKey: "object" },
        { op: "Table Policy Update", stage: "table_policy_lifecycle", behavior: "benign", policyId: 0, role: 3, resource: "LocalResourceTable", action: "view", permission: "allow" },
        { op: "Table Policy Delete", stage: "table_policy_lifecycle", behavior: "benign", policyId: 0 },
        { op: "Role Swap", stage: "role_management", behavior: "benign", account1Key: "subject", account2Key: "regular_local" },
        { op: "Role Status Update", stage: "role_management", behavior: "benign", targetKey: "regular_local", status: "BENIGN" },
        { op: "Role Reward", stage: "role_management", behavior: "benign", targetKey: "regular_local", amount: 1 },
        { op: "Role Penalize", stage: "role_management", behavior: "benign", targetKey: "regular_local", amount: 1 },
        { op: "Role Revoke", stage: "role_management", behavior: "benign", targetKey: "regular_local" },
      ],
    },
    {
      id: "timing_breakdown_cross_pgh_01",
      group: SCENARIO_GROUP.TIMING,
      mode: "pgh_pgh",
      deterministic: true,
      description: "Cross-PGH timing decomposition with benign and malicious calls over the same federated path.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghA_object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghB_subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control without Misbehavior", stage: "timing_probe", behavior: "benign", direction: "B_to_A", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Access Control with Misbehavior", stage: "timing_probe", behavior: "malicious", direction: "B_to_A", resource: DEFAULT_RESOURCE, action: "edit" },
      ],
    },
    {
      id: "timing_breakdown_multi_call_01",
      group: SCENARIO_GROUP.TIMING,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Multi-call local timing decomposition with policy lifecycle transitions and threat handling.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Update", stage: "timing_probe", behavior: "benign", policyId: 0, resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control without Misbehavior", stage: "timing_probe", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view" },
        { op: "Access Contract Deactivate", stage: "timing_probe", behavior: "benign" },
        { op: "Access Contract Activate", stage: "timing_probe", behavior: "benign" },
        { op: "Access Control with Misbehavior", stage: "timing_probe", behavior: "malicious", resource: DEFAULT_RESOURCE, action: "edit" },
      ],
    },
    {
      id: "threat_privilege_escalation_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Privilege escalation and admin-function abuse attempts across policy, role, and registry flows.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "subject", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "attacker_policy", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Add", stage: "attack", behavior: "malicious", actorKey: "attacker_policy", resource: DEFAULT_RESOURCE, action: "edit", permission: "allow" },
        { op: "Policy Update", stage: "attack", behavior: "malicious", actorKey: "attacker_policy", policyId: 0, resource: DEFAULT_RESOURCE, action: "edit", permission: "allow" },
        { op: "Access Contract Set Judge", stage: "attack", behavior: "malicious", actorKey: "attacker_policy" },
        { op: "Access Contract Deactivate", stage: "attack", behavior: "malicious", actorKey: "attacker_policy" },
        { op: "Role Swap", stage: "attack", behavior: "malicious", actorKey: "attacker_policy", account1Key: "subject", account2Key: "object" },
        { op: "Register Set Judge Contract", stage: "attack", behavior: "malicious", actorKey: "attacker_policy" },
      ],
    },
    {
      id: "threat_unauthorized_access_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_pgh",
      deterministic: true,
      description: "Unauthorized federated access attempt against an existing allow-view policy.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghA_object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghB_subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control with Misbehavior", stage: "attack", behavior: "malicious", direction: "B_to_A", resource: DEFAULT_RESOURCE, action: "delete" },
        { op: "Create Table Access Request with Misbehavior", stage: "attack", behavior: "malicious", scope: "local", resource: "LocalResourceTable", action: "delete", requesterKey: "pghB_subject" },
      ],
    },
    {
      id: "threat_tampering_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Tampering-oriented threat workflow including direct unauthorized policy and table mutation attempts.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "subject", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "regular_local", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Policy Update", stage: "attack", behavior: "malicious", actorKey: "regular_local", policyId: 0, resource: DEFAULT_RESOURCE, action: "edit", permission: "allow" },
        { op: "Policy Delete", stage: "attack", behavior: "malicious", actorKey: "regular_local", policyId: 0 },
        { op: "Access Control with Misbehavior", stage: "attack", behavior: "malicious", resource: DEFAULT_RESOURCE, action: "delete" },
        { op: "Create Table Access Request with Misbehavior", stage: "attack", behavior: "malicious", scope: "local", resource: "LocalResourceTable", action: "delete", requesterKey: "regular_local" },
        { op: "Table Edit Local Resource", stage: "attack", behavior: "malicious", scope: "local", requesterKey: "regular_local", account1Key: "subject", account2Key: "regular_local" },
        { op: "Table Delete Local Resource", stage: "attack", behavior: "malicious", scope: "local", requesterKey: "regular_local", targetAccountKey: "subject" },
      ],
    },
    {
      id: "threat_too_frequent_access_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_blockchain",
      deterministic: true,
      description: "Burst of repeated unauthorized accesses to trigger too-many-attempts threat logic.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control with Misbehavior", stage: "attack_burst", behavior: "malicious", resource: DEFAULT_RESOURCE, action: "delete", repeat: 7 },
        { op: "Create Table Access Request with Misbehavior", stage: "attack_burst", behavior: "malicious", scope: "local", resource: "LocalResourceTable", action: "delete", requesterKey: "subject", repeat: 2 },
      ],
    },
    {
      id: "threat_dos_like_pattern_01",
      group: SCENARIO_GROUP.THREAT,
      mode: "pgh_pgh",
      deterministic: true,
      description: "Extended repeated federated unauthorized requests to emulate DoS-like pressure.",
      operations: [
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghA_object", memberType: "type1" },
        { op: "Role Assignment", setup: true, stage: "identity_bootstrap", behavior: "benign", actor: "pghB_subject", memberType: "type1" },
        { op: "Policy Add", setup: true, stage: "policy_setup", behavior: "benign", target: "A", objectKey: "pghA_object", subjectKey: "pghB_subject", resource: DEFAULT_RESOURCE, action: "view", permission: "allow" },
        { op: "Access Control with Misbehavior", stage: "dos_burst", behavior: "malicious", direction: "B_to_A", resource: DEFAULT_RESOURCE, action: "delete", repeat: 18 },
        { op: "Create Table Access Request with Misbehavior", stage: "dos_burst", behavior: "malicious", scope: "local", resource: "LocalResourceTable", action: "delete", requesterKey: "pghB_subject", repeat: 3 },
      ],
    },
    ...buildThreatDuringAfterScenarios(),
    buildScalabilityScenario(5),
    buildScalabilityScenario(15),
    buildScalabilityScenario(45),
  ];

  const filtered = all
    .filter((scenario) => includeModeB || scenario.mode !== "pgh_pgh")
    .map((scenario) => ({
      ...scenario,
      operations: maybeStripSetup(scenario.operations, includeSetup),
    }));

  const scenarioMap = {};
  const groups = {};
  for (const scenario of filtered) {
    scenarioMap[scenario.id] = scenario;
    if (!groups[scenario.group]) groups[scenario.group] = [];
    groups[scenario.group].push(scenario);
  }

  const defaultScenarioIds = [
    "normal_rich_federated_success_01",
    "normal_rich_federated_success_02",
    "timing_breakdown_cross_pgh_01",
    "threat_unauthorized_access_01",
  ].filter((id) => scenarioMap[id]);

  const mandatory = scenarioMap.normal_rich_federated_success_01 || filtered[0] || null;

  return {
    mandatory,
    pool: filtered,
    scenarios: filtered,
    scenarioMap,
    groups,
    defaultScenarioIds,
    defaults: { DEFAULT_ACC_TYPE, DEFAULT_RESOURCE },
  };
}

module.exports = {
  buildScenarioLibrary,
  DEFAULT_ACC_TYPE,
  DEFAULT_RESOURCE,
  SCENARIO_GROUP,
};
