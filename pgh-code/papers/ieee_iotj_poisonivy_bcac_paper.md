# A Behavior-Aware Blockchain Access Control Architecture for Clustered IoT: Design, Implementation, and Poison Ivy-Style Evaluation

**Draft prepared in IEEE IoT Journal style**  
**Repository-based manuscript using actual run data from `poisonivy-actual-fixed-20260601T180452Z`**

**Authors:** _To be inserted_  
**Affiliations:** _To be inserted_

## Abstract
The Internet of Things (IoT) has reached a scale at which centralized access-control architectures become operational bottlenecks, while static authorization mechanisms fail to react adequately to compromised devices that already possess legitimate identities. This paper presents a behavior-aware blockchain access-control (BCAC) architecture for clustered IoT environments, implemented and evaluated in a working software stack consisting of ESP32-oriented edge devices, an ESP bridge service, a Primary Group Head (PGH) control layer, and a family of Ethereum smart contracts. The design combines a Register Contract, Access Control Contracts (ACCs), a Judge Contract (JC), Role-Based Access Control (RBAC), and token-backed role state to provide identity onboarding, policy enforcement, behavior-sensitive penalty assignment, temporary quarantine, bounded recovery, and permanent revocation. Rather than treating blockchain as a passive audit sink, the implementation uses the blockchain as the active enforcement and adjudication layer while the bridge and PGH layers provide device mediation and policy orchestration.

A Poison Ivy-style bridge compromise scenario is used to evaluate the architecture under a realistic trust-abuse model. In this scenario, a legitimate-looking ESP identity is onboarded through the same provisioning path as benign devices, performs self-access successfully, then attempts unauthorized lateral access against another ESP device through the bridge. The Judge Contract progressively penalizes the compromised device across three malicious waves, applies timed quarantine after repeated hostile activity, permits limited benign recovery after a quiet period, and permanently revokes the device by the third wave. The fixed actual run analyzed in this paper executed 13 logical actions and 25 on-chain transactions, consumed 10,055,491 gas, triggered 11 penalty events, 2 reward events, and 2 temporary quarantine events, and culminated in permanent revocation with successful post-revocation denial. The results show that the architecture can preserve auditable, transaction-level accountability for access decisions while supporting dynamic incident response in clustered IoT deployments.

The main contribution of this work is not the invention of blockchain-based access control in general, nor of the ACC/JC/RC contract family in isolation. Instead, the contribution is a complete and operationalized realization of that model for clustered IoT, extended with gateway-mediated device semantics, progressive behavior-aware adjudication, explicit recovery logic, and a reproducible Poison Ivy-style attack evaluation using actual transaction traces and result artifacts. The paper also positions the architecture relative to prior blockchain-enabled IoT access-control research and discusses how the design can be applied to enterprise and industrial IoT environments where gateway clusters, auditability, and incident containment are critical.

**Index Terms**—Internet of Things, blockchain access control, smart contracts, Ethereum, ESP32, industrial IoT, access control contract, judge contract, behavioral security, dynamic authorization.

## I. Introduction
Access control in IoT systems is difficult for two reasons that often collide. First, IoT deployments are operationally decentralized: devices are distributed across sites, zones, subnets, and administrative domains, and many of them are too constrained to host heavyweight security services. Second, IoT threats are increasingly behavioral rather than purely identity-based. A device may have a legitimate identity, valid provisioning state, and previously authorized access, yet become malicious after compromise, misconfiguration, lateral movement, firmware tampering, or controller abuse. Traditional centralized access-control architectures, and even many decentralized ones, focus heavily on identity registration and static policy evaluation while under-specifying the problem of how the system should react after a node begins to behave maliciously.

Blockchain-based access control has been proposed as a way to remove the single point of failure of centralized policy servers, improve auditability, and coordinate trust across distributed parties. Prior work includes fully distributed role and permission arbitration for IoT [6], capability-based decentralized access control [3], capability-based access control with decentralized identifiers [5], dynamic trust and reputation systems [4], hierarchical blockchain or multi-chaincode schemes [7], and survey literature indicating that smart contract-based access control has become a significant branch of IoT security research [9]. In parallel, an earlier smart-contract architecture based on multiple Access Control Contracts, a Judge Contract, and a Register Contract proposed a direct mechanism for combining static authorization with behavior-based dynamic validation [1]. That contract family is also reflected in a later multi-contract IoT data-sharing architecture [2].

However, there is still a gap between contract-level proof-of-concept designs and a realistic, cluster-aware, bridge-mediated IoT deployment. Many prior works either emphasize authorization logic without deeply modeling progressive sanctions, or they implement trust and reputation without tying that logic to a practical device-bridge-gateway stack. In enterprise and industrial IoT, this gap matters. Devices often reach protected resources through edge gateways, protocol bridges, brokers, or local service heads. The security question is therefore not only whether a blockchain can say "allow" or "deny," but whether the architecture can continue to make defensible decisions when a previously trusted integration component or endpoint begins abusing that trust.

This paper addresses that gap by presenting a complete implementation and evaluation of a BCAC stack in a repository-backed system comprising the following components: 1) an ESP bridge that receives device telemetry and mediates device-to-device access requests, 2) a PGH service that provisions identities, deploys subject/object-specific ACCs, writes and evaluates access policies, and enforces gateway-side containment, 3) smart contracts for role management, registration, access control, and adjudication, and 4) an evaluation runner that executes deterministic attack scenarios and harvests actual blockchain transaction data. The focal scenario is a Poison Ivy-style ESP bridge compromise. The term "Poison Ivy-style" is used here to denote a controller-trust-abuse pattern: an attacker appears as a benign device or integration component, uses legitimate provisioning paths, and then leverages that position to request unauthorized lateral access. This is not a malware reverse-engineering paper, and it does not claim to re-implement a specific malware family. Instead, it uses a well-understood trust-abuse narrative to stress the access-control architecture under realistic conditions.

The paper makes four concrete contributions.

1. It documents a working clustered-IoT BCAC architecture in which device-facing bridge APIs, PGH logic, and Ethereum smart contracts cooperate to perform both authorization and behavioral adjudication.
2. It explains the design and implementation of a progressive Judge Contract model featuring a security budget, temporary quarantine, bounded benign recovery, and permanent revocation.
3. It evaluates the design using an actual Poison Ivy-style scenario run stored in `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z`, rather than with illustrative or synthetic numbers.
4. It positions the implementation relative to prior blockchain-IoT access-control literature and argues for its applicability to enterprise and industrial IoT environments.

The rest of the paper is organized as follows. Section II discusses related work and establishes the novelty boundary. Section III introduces the architecture and trust model. Section IV examines the smart-contract design, with emphasis on the ACC and JC. Section V explains how the Poison Ivy-style attack was implemented in the project. Section VI describes the experimental setup and data sources. Section VII reports results from the fixed actual run. Section VIII discusses the implications, strengths, and limitations of the architecture. Section IX explains enterprise and industrial applicability. Section X concludes.

## II. Related Work and Novelty Boundary
Blockchain-enabled IoT access control is not a new idea. The relevant literature is already broad enough that overclaiming novelty would be technically incorrect. A defensible contribution statement must therefore separate what is inherited from prior work from what is newly implemented or extended in this project.

Zhang _et al._ proposed a smart contract-based IoT access-control framework composed of multiple ACCs, a JC, and an RC, where each ACC validates access rights for one subject-object pair and the JC judges misbehavior and returns penalties [1]. This is the clearest conceptual ancestor of the architecture implemented here. In other words, the idea that a dedicated judge-like smart contract can participate in IoT access control is already present in the literature. Likewise, Sultana _et al._ proposed a blockchain-based IoT data-sharing system that also uses ACC, RC, and JC contracts, with the JC checking user misbehavior and defining penalties [2]. Therefore, the existence of ACC/JC/RC as a contract family is not itself the novel result of this work.

BlendCAC shifted the discussion toward decentralized capability-based authorization, emphasizing scalability, delegation, and federated access-right management [3]. It proposed a partially decentralized capability-based framework implemented over blockchain and verified through a physical IoT proof of concept. Capability-based approaches such as BlendCAC are important because they show how blockchain can move beyond simple identity registration. However, BlendCAC is fundamentally a capability-delegation system, not a behavior-sensitive adjudication framework. It does not place a sanctioning contract analogous to the JC at the center of incident response, nor does it model repeated hostile attempts as a first-class behavioral state machine.

Capability-based IoT access control using blockchain and decentralized identifiers further demonstrated that decentralized access-management architectures can be made systematic and scalable [5]. Novo’s architecture for scalable IoT access management argued that centralized models create significant limitations when billions of devices must be managed globally [6]. Sun _et al._ later addressed security, lightweight operation, and cross-domain access using Hyperledger Fabric and domain-specific ledgers [11]. These works demonstrate that scalability, decentralized state, and inter-domain authorization are central to blockchain-IoT research. Nonetheless, they generally focus on policy distribution, identity, delegation, and domain structure more than on progressive behavioral enforcement for already-authenticated devices.

Trust- and reputation-aware designs narrow that gap. Putra _et al._ explicitly noted that dynamic interaction in IoT environments remains insufficiently captured by many blockchain access-control systems and proposed a blockchain-based trust and reputation system for IoT access control [4]. Reputation-enhanced access-control proposals likewise attempt to integrate malicious-behavior signals into authorization [4]. These works are highly relevant to the present project, because the present Judge Contract is also behavior-aware. The difference is architectural. In the project documented here, behavior assessment is not implemented as a separate reputation layer that merely adjusts policy levels. Instead, it is integrated into the online access path through ACC-to-JC calls, token penalties, a dedicated security budget, timed quarantine, benign recovery, and gateway-triggered permanent containment.

Hierarchical and industrial designs provide another point of comparison. Hierarchical blockchain-based multi-chaincode access-control frameworks seek to reduce storage complexity while preserving smart-contract enforcement [7]. Policy-domain frameworks for distributed industrial IoT target multi-domain coordination and enterprise-scale authorization [8]. IFIP’s discussion of blockchain-based identity and access management in industrial IoT explicitly highlights architectures with cluster heads, subdomains, and the use of multiple smart contracts, including a Judge Contract that evaluates behavior and applies sanctions [10]. This makes such work especially relevant, because the present implementation also operates with cluster semantics and gateway heads. Nevertheless, the present project contributes a more concrete end-to-end attack evaluation anchored in a bridge service and actual device-oriented flows. It does not stop at saying that behavior can be judged; it shows how repeated malicious requests coming from a realistic device-facing path lead to specific, measured changes in on-chain state.

The broader survey literature confirms that blockchain-enabled IoT access-control research is already rich and diverse. A 2022 systematic review lists Ethereum- and Hyperledger-based approaches spanning capability-based access control, ABAC, cross-domain access, and trust/reputation systems [9]. The review makes clear that many proposals exist, but it also suggests a recurring problem: most systems emphasize authorization models, trustless storage, or cross-domain mechanics, while fewer provide integrated, attack-driven evaluations of how the system reacts when an authenticated device repeatedly misbehaves.

Accordingly, the novelty claim of the present work is bounded and specific.

First, the project operationalizes the ACC/JC/RC model inside a clustered IoT gateway stack, rather than leaving it as an abstract contract design or a small proof-of-concept topology. Second, the Judge logic has been extended into a staged penalty mechanism with a visible security budget, wave-based escalation, timed quarantine, bounded benign recovery, and permanent revocation. Third, the architecture is evaluated through a Poison Ivy-style bridge compromise scenario in which the blockchain remains the enforcement layer and every important decision is observable in transaction-level logs. Fourth, the system is instrumented well enough to yield action-level, transaction-level, and scenario-level evidence from a live run, not merely theoretical claims or synthetic estimates.

In short, the contribution is best described as a behavior-aware systems implementation and evaluation contribution for blockchain-backed clustered IoT access control, rather than as the first proposal of blockchain access control, the first use of judge contracts, or the first use of blockchain in IoT generally.

## III. Architecture and Trust Model
### A. Clustered IoT Model
The implementation assumes that IoT devices exist in clusters represented by a shared member type and managed through a gateway or service head. In the code base, this idea is reflected in the role and table structures maintained by `RoleToken` and `RoleBasedAccessControl`. The `RoleToken` contract assigns each participant one of four non-empty roles—ADMIN, PRIMARY_GROUP_HEAD, SECONDARY_GROUP_HEAD, or REGULAR_MEMBER—and groups members by `memberType` into local and global resource tables. The first device or principal registered for a member type becomes the primary group head for that type, the second becomes the secondary head, and later devices become regular members. This role and type structure is not incidental; it is how the project expresses clustered IoT governance at the blockchain layer.

The practical consequence is that access-control contracts are not deployed arbitrarily between any two addresses. The `AccessControlFactory` first checks whether the subject and object are in the same group or both globally visible via `areSameOrGlobalMembers`, and only then deploys an `AccessControlContract` for the specific object-subject-type tuple. The `RegisterContract` persists that association so that later policy writes and access evaluations can locate the correct ACC deterministically.

This cluster-aware design maps reasonably well to enterprise and industrial environments. A member type can represent a line, site, production cell, department, or device family. The primary and secondary heads resemble gateway controllers or policy authorities. Local resource tables resemble zone-specific rosters, whereas the global table resembles cross-zone or federated authority information.

### B. ESP Bridge, PGH, and Blockchain Interaction
The device-facing entry point of the architecture is the ESP bridge implemented in `esp_api_project/esp_api_2waycomm.py`. It receives telemetry at `POST /data`, maintains a local SQLite state store, exposes device-oriented endpoints such as `GET /status/<mac>` and `GET /temps/<mac>`, and can receive local administrative approvals through endpoints such as `POST /approve-access`. The PGH service in `iot/pi/primary_head.js` provides the blockchain-facing orchestration layer. It exposes HTTP endpoints for registration, contract deployment, policy provisioning, and on-chain access evaluation. Finally, the Ethereum-compatible blockchain hosts the smart contracts.

The resulting architecture is deliberately hybrid. The bridge is used because physical IoT devices are better represented by MAC-keyed, API-mediated identities than by direct blockchain wallets. The PGH is used because it centralizes the logic for provisioning and evaluation while still writing decisions to the blockchain. The smart contracts are used because they provide authoritative enforcement and auditable state transitions.

### C. Local Permissions Versus On-Chain Permissions
One subtle but important design choice is the distinction between local bridge approvals and blockchain state. The bridge maintains local tables such as `approvals` and `access_grants` in SQLite, which it can consult quickly when serving device requests. However, the blockchain does not read SQLite directly. The blockchain only knows what is written into smart-contract state. Accordingly, local approval and on-chain authority are not conceptually identical.

The bridge does already translate some local decisions into blockchain policies. During `POST /data`, the bridge calls `ensure_contract_and_policy`, which can register a device, deploy an ACC, and insert default allow policies for self-status and self-temperature resources. During `POST /approve-access`, the bridge updates the local access-grants table and then calls `grant_access_policy`, which writes on-chain allow policies for the requestor to view the target’s status and temperature resources. During `GET /status/<mac>` and `GET /temps/<mac>`, the bridge still calls PGH for on-chain evaluation so that the blockchain remains the effective enforcement layer.

This split is central to the enterprise relevance of the architecture. In practice, enterprises often need both local operational autonomy and a stronger system of record. The bridge gives the first. The blockchain gives the second. The price of that hybrid design is synchronization complexity, especially when local approvals and blockchain provisioning can drift apart. That issue is discussed later as a deployment consideration and future improvement area.

### D. Threat Model
The threat model is behavior-centric. The attacker is not modeled as a completely unknown outsider, but as an endpoint or controller-side component that already appears legitimate to the system. In the Poison Ivy scenario, the compromised ESP identity is provisioned through the same bootstrap path as benign devices. The attack begins only after that identity successfully exercises ordinary self-access. This is important because it tests the part of access control that matters most in real operations: how the system responds when a valid identity becomes abusive.

The adversary is assumed capable of sending repeated device-oriented status and temperature requests through the bridge, and, in the broader system narrative, capable of abusing controller trust. The architecture must therefore do more than enforce a static policy once. It must register repeated malicious behavior, escalate its response over time, permit bounded recovery if the node becomes quiet and behaves benignly, and eventually revoke the node if hostile behavior persists.

## IV. Smart-Contract Design
### A. RoleToken and Role-Based Access Control
The role layer is implemented by `RoleToken.sol` and `RoleBasedAccessControl.sol`. `RoleToken` is an ERC20-based contract that combines token balances, member metadata, role assignment, local and global resource tables, and member status strings such as `BENIGN`, `SUSPICIOUS`, and `MALICIOUS`. Importantly, the contract mints role-dependent token balances when a role is assigned, burns balances when roles are revoked, and exposes functions to penalize and reward members. `RoleBasedAccessControl` acts as the administration-facing wrapper and exposes methods such as `assignRole`, `revokeRole`, `swapRole`, `updateMemberStatus`, `penalizeMember`, and `rewardMember`.

This design means that membership, policy authority, and token-backed incentives are not separate systems. Instead, the access-control stack can treat role and economic state as one governance layer. The Judge Contract later uses that layer to impose sanctions and rewards.

### B. Register Contract and AccessControlFactory
The `RegisterContract` records which ACC corresponds to which object-subject-type tuple. This registry function matters because a device cluster can easily contain many resource owners and requestors, and the system needs a deterministic way to locate the correct ACC for provisioning and enforcement. The `AccessControlFactory` deploys new ACCs, initializes them with the RBAC and JC addresses, and registers them with the `RegisterContract`.

The factory enforces a structural constraint that is meaningful in clustered IoT: the subject and object must either belong to the same member type or both appear as globally visible members. This helps ensure that the blockchain layer respects the clustered topology rather than permitting unrestricted contract proliferation.

### C. AccessControlContract
The `AccessControlContract` is the heart of authorization enforcement. It stores a list of policies, where each policy records a `resource`, an `action`, a `permission`, and the `timeOfLastRequest`. Several parts of the contract deserve emphasis.

First, access is scoped to one subject-object pair and one access-control type. This avoids a monolithic global policy engine and instead yields smaller, addressable enforcement units. Second, the contract distinguishes permanent revocation from temporary quarantine. If the JC reports permanent revocation, the ACC denies immediately via `_handlePermanentRevocation`. If the JC reports temporary quarantine, the ACC still submits the request to the JC as a blocked repeated malicious attempt and returns `false` without reverting. This distinction is critical. It ensures that the system keeps recording malicious activity during temporary containment rather than simply losing visibility behind early reverts.

Third, the ACC performs both static and dynamic validation. Static validation means matching `resource` and `action` against stored policies and checking whether the policy permission is `allow` or not. Dynamic validation means checking the time threshold for repeated requests and consulting the JC for misbehavior handling. If an allowed policy is matched, the ACC can still deny on the basis of too-frequent access. If a policy is absent or denies the request, the ACC invokes the JC with reasons such as `Unauthorized access attempt` or `Tampering with data`. Thus, the blockchain does not merely answer whether a rule exists; it also decides whether the subject’s recent behavior invalidates the access in practice.

### D. Judge Contract
The `JudgeContract` is the main behavioral-security mechanism. In the present implementation, it goes well beyond a binary malicious/not-malicious flag and instead maintains explicit per-member security state. That state includes a wave index, consecutive malicious count, blocked-attempt count within the current wave, quarantine level, quarantine expiration, permanent-revocation flag, last malicious timestamp, last benign timestamp, security token budget, cumulative penalty, and initialization status.

The contract defines penalties for several behavior categories, including `Unauthorized access attempt`, `Too frequent access`, `Blocked repeated malicious attempt`, `Tampering with data`, `Privilege escalation`, `Spoofing attempt`, `Repudiation attempt`, and `Denial of Service`. Each reason maps to a severity level, role-dependent token deductions, and a security-budget deduction. This matters because the project intentionally separates two different notions of punishment.

The first notion is economic punishment, implemented by burning or deducting `RoleToken` units from the member. The second notion is operational-security state, implemented by the `securityTokenBudget`. The latter starts at 100, decreases with malicious behavior, can increase slightly with bounded benign recovery, and triggers permanent revocation once sufficiently depleted in later waves. This separation makes the system easier to reason about operationally. The token balance represents economic stake or role assets, whereas the security budget represents remaining behavioral tolerance.

A key design decision is how malicious waves are handled. The JC increments the wave index when a new wave begins, records malicious attempts, and counts repeated malicious actions within the same wave. After three blocked attempts in the same wave, the JC applies a wave-escalation penalty, deducts an additional amount from the security budget, and starts a timed quarantine. The quarantine duration scales with the wave index, so later waves imply stronger short-term containment. If the subject subsequently remains quiet long enough and performs a benign action, the JC can reward the subject and partially restore its security budget. The restoration is deliberately small, preventing full rehabilitation after serious attacks.

Finally, if the wave index is high enough and the remaining security budget falls below the permanent revocation threshold, the JC triggers irreversible containment. In that state, the subject is marked permanently revoked, later requests return denial, and the PGH can enforce additional containment by deactivating the ACC and revoking the blockchain role.

### E. PGH-Side Containment and Threat Engine
The PGH service augments the contract logic with a threat engine and gateway-side containment view. `evaluateAccessCore` in `primary_head.js` locates the appropriate ACC, reads pre- and post-judge state, sends a real subject-signed on-chain access transaction if requested, interprets the transaction result, and then asks `ThreatEngine` to assess the request. `ThreatEngine` tracks per-subject attempt counts, keeps a gateway quarantine map keyed by subject address, aligns its timing to chain time, and can classify threat findings such as `UNAUTHORIZED_ACCESS`, `TOO_MANY_ACCESS_ATTEMPTS`, and `DISRUPTION_OF_SERVICE`.

A crucial implementation detail is that when the JC indicates permanent revocation, the PGH can enforce permanent containment by calling `deactivateContract()` on the ACC and `revokeRole()` on the RBAC layer. This means the architecture uses both smart-contract state and gateway orchestration to complete the incident-response loop. The blockchain records the behavioral state and sanction event, while the gateway performs the operational clean-up needed to ensure that later requests remain denied.

## V. Poison Ivy-Style Attack Implementation
### A. Why a Poison Ivy-Style Scenario?
The project uses the phrase "Poison Ivy-style" to denote a class of controller-trust abuse rather than a specific malware implementation. In many enterprise IoT environments, the highest-value attacker is not necessarily one who breaks the cryptography or defeats the ledger directly. Instead, it is one who compromises a controller, agent, bridge, or well-provisioned device identity and then abuses that position to request resources that it should not have. This model fits enterprise reality because gateways, middleware, edge collectors, and API bridges are frequently trusted by many downstream systems.

The ESP bridge in this repository is a suitable attack surface for that reason. It is the point at which MAC-keyed device identities are translated into blockchain subjects and PGH requests. A compromise of this layer does not automatically imply a compromise of the blockchain. Rather, it creates a situation in which the attacker speaks through a legitimate pathway and therefore tests whether the blockchain access-control architecture can still make correct and auditable decisions.

### B. Scenario Composition
The scenario is encoded as `threat_during_after_poison_ivy_esp_bridge_compromise_01` in `eval/scenario_library.js`. It comprises 13 logical actions.

1. Role assignment for the protected object.
2. Telemetry bootstrap for the victim ESP.
3. Telemetry bootstrap for a helper ESP.
4. Telemetry bootstrap for the compromised ESP.
5. Benign self-access by the compromised ESP.
6. Unauthorized lateral status read.
7. Unauthorized lateral temperature read.
8. Wave 1 repeated malicious burst.
9. Wave 1 benign recovery.
10. Wave 2 repeated malicious burst.
11. Wave 2 benign recovery.
12. Wave 3 repeated malicious burst until permanent revocation.
13. Post-revocation validation attempt.

The helper ESP is included only for realistic multi-device provisioning and not as an active attacker or victim later in the flow. The compromised ESP and victim ESP drive the actual attack.

### C. Execution Semantics
The runner executes the scenario through a sandboxed copy of the ESP bridge database, not through the original bridge database. The original database is used as a source snapshot, copied into a temporary sandbox directory, and then mutated during the run. This preserves the realism of a live ESP bridge while protecting the canonical local dataset from contamination.

At runtime, the bridge exposes `/data`, `/status/<mac>`, and `/temps/<mac>` endpoints, and records blockchain-facing actions into its `chain_actions` table. The runner harvests transaction hashes from that table and passes them through the same transaction-description and logging pipeline used by other scenarios. This means the Poison Ivy evaluation is not isolated from the thesis measurement framework; it produces the same transaction-level, action-level, and scenario-level outputs as other scenarios.

### D. Timed Waves and Chain-Time Advancement
The wave-based scenario depends on timed quarantine and timed recovery. To make the experiment practical, the runner advances blockchain time between waves rather than sleeping in wall-clock time. This is a common technique on development chains such as Ganache. The key point is that the timing relevant to the JC is `block.timestamp`, so advancing chain time is equivalent to allowing the quarantine to expire from the contract’s perspective. This enables reproducible evaluation of multi-wave behavior without waiting minutes in real time.

### E. Actual Device and Actor Identities in the Fixed Run
The fixed actual run analyzed in this paper used the following ESP-layer actors.

- Compromised ESP MAC: `F4:65:0B:48:CC:8C`
- Victim ESP MAC: `A0:DD:6C:B2:4F:58`
- Helper ESP MAC: `44:1D:64:F7:6B:3C`
- Protected object blockchain address: `0xe5abdad6a8da4d21c8c2607ecbca9ab40d1ab751`
- Compromised ESP blockchain identity: `0xBF827e410dc2e59A1d08042252d92312470ccFC1`

These values matter because the scenario is not merely symbolic. Every relevant bootstrap, policy, access decision, and Judge event is tied to a concrete on-chain address or a concrete bridge identity.

## VI. Experimental Methodology
### A. Execution Environment
The analyzed run is the fixed actual run stored under `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z`. The run used a single PGH (`PGH_A`) operating in `pgh_blockchain` mode, a chain ID of `1337`, and the RPC endpoint `http://10.10.1.34:8545`. According to `run_manifest.json`, the run began at `2026-06-01T18:04:53.852Z` and ended at `2026-06-01T18:06:09.295Z`, with a block range from 68 to 98. The scenario was executed deterministically with setup included.

### B. Data Sources
Four categories of evidence are used in this paper.

1. `gas_action_level.csv` provides action-level summaries for each logical step, including total gas, outcome, Judge events, timing, and explanatory notes.
2. `gas_tx_level.csv` provides transaction-level evidence, including contract names, function names, gas used, status, transaction hashes, and decoded Judge events.
3. `scenario_summary.json` provides scenario-level totals such as total actions, total transactions, total gas, Judge event counts, total penalty amounts, and total reward amounts.
4. The sandbox ESP database provides chain-action traces and post-request Judge state values, enabling reconstruction of the security-budget trajectory across the malicious waves.

The paper also uses four figure files generated directly from those artifacts:

- `figure_01_action_timeline.svg`
- `figure_02_transaction_effects.svg`
- `figure_03_summary_dashboard.svg`
- `figure_04_security_state_evolution.svg`

### C. Evaluation Questions
The experiment is intended to answer the following questions.

1. Can the architecture onboard a legitimate-looking ESP identity and still later identify it as malicious based on behavior?
2. Does the blockchain remain the effective enforcement and adjudication layer for both normal and malicious device access?
3. Can the JC progress from simple penalties to timed quarantine, bounded recovery, and permanent revocation using on-chain state?
4. What is the transaction and gas profile of such a behavior-aware incident-response cycle?
5. Is the architecture meaningful for clustered enterprise or industrial IoT environments, or is it only a contract-level toy example?

### D. Metrics
The core metrics in the present run are as follows.

- Total logical actions: 13
- Total on-chain transactions: 25
- Total gas used: 10,055,491
- Total fee paid: 10,056,088,847,215,671 wei
- Total communication latency: 9,654 ms
- Total blockchain processing time: 17,823 ms
- Judge penalty event count: 11
- Judge penalty amount total: 75,000
- Judge reward event count: 2
- Judge reward amount total: 2,000
- Judge block event count: 2
- Overall outcome: `completed_with_threats`

These values were taken from `scenario_summary.json` for the fixed actual run.

## VII. Results
### A. Overall Scenario Result
The fixed actual run completed successfully as a threat scenario. The scenario summary reports 13 actions, 25 transactions, and 10,055,491 gas, with Judge activity confirmed and the overall outcome labeled `completed_with_threats`. The involved contracts were `RoleBasedAccessControl`, `RoleToken`, `AccessControlFactory`, `AccessControlContract`, `RegisterContract`, and `JudgeContract`. The involved functions were `assignRole`, `deployAccessControlContract`, `policyAdd`, and `accessControl`. These totals already suggest two important facts. First, the scenario used the full contract stack rather than a reduced subset. Second, the dominant operations were provisioning and access evaluation, which is exactly what one would expect in a realistic bridge-mediated IoT scenario.

![Figure 1. Action-level timeline for the fixed actual Poison Ivy run.](../results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_01_action_timeline.svg)

**Figure 1.** Action-level timeline generated from the actual run data in `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_01_action_timeline.svg`.

![Figure 2. Transaction-level gas and effect view for the fixed actual run.](../results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_02_transaction_effects.svg)

**Figure 2.** Transaction-level effects generated from the actual run data in `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_02_transaction_effects.svg`.

![Figure 3. Scenario summary dashboard for the fixed actual run.](../results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_03_summary_dashboard.svg)

**Figure 3.** Scenario summary dashboard generated from the actual run data in `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_03_summary_dashboard.svg`.

![Figure 4. Security-state evolution for the compromised ESP identity.](../results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_04_security_state_evolution.svg)

**Figure 4.** Security-state evolution generated from the actual run data in `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/figures/figure_04_security_state_evolution.svg`.

### B. Provisioning and Baseline Phase
The first four logical actions established the protected object and the ESP actors. The object role assignment consumed 461,390 gas. The victim ESP telemetry bootstrap consumed 371,776 gas and yielded one mined transaction, indicating that much of the required state already existed or was satisfied through non-mining code paths. By contrast, the helper ESP bootstrap and the compromised ESP bootstrap each produced five on-chain transactions and consumed 3,015,793 gas. Those two full bootstrap sequences each included one `assignRole`, one `deployAccessControlContract`, and three `policyAdd` calls. The helper and compromised bootstraps therefore dominated the provisioning cost.

This heterogeneity is a useful result in itself. It shows that blockchain provisioning cost is path-dependent. If an ACC already exists or some policies are already present, the gas profile of bootstrap can be far lower. Conversely, a new subject entering the cluster and requiring full contract creation and self-policy insertion incurs a visibly higher cost.

After provisioning, the compromised ESP performed a benign self-status access. That access succeeded and consumed 175,919 gas. No Judge events were emitted. This is the desired baseline: the node was legitimate, provisioned, and capable of ordinary self-access.

### C. Initial Lateral Probes
The first two malicious actions were a lateral status probe and a lateral temperature probe. The status probe consumed 311,199 gas and produced the Judge event sequence `StatusUpdated, Penalized, OffenseRecorded`. The action outcome was denied. The temperature probe consumed 267,338 gas and again produced `StatusUpdated, Penalized, OffenseRecorded`. These two events prove that the system did not treat the compromise as a purely local bridge issue. Instead, the attempted lateral reads passed through the blockchain access-control path, were denied there, and caused the JC to update the subject’s behavior-related state.

At the action level, these are the first points at which the system moves the subject from benign behavior into formally malicious or suspicious territory. At the transaction level, they are the first points at which the ACC and JC interact in response to hostile requests. At the scenario level, they establish the baseline from which wave-based escalation becomes meaningful.

### D. Wave 1: Quarantine as Short-Term Containment
Wave 1 was implemented as a repeated burst of malicious status and temperature requests. In the fixed actual run, the action-level row for `wave1_attack` recorded two transactions totaling 603,048 gas. The important point is not simply that two requests occurred, but why only two were needed. The earlier lateral probes already counted toward the accumulated malicious-behavior state. Therefore, the first wave did not need to start from zero. After two additional malicious requests, the JC emitted `MemberBlocked` and `QuarantineStartedOrUpdated` in addition to `StatusUpdated`, `Penalized`, and `OffenseRecorded`.

This is the first true containment point in the scenario. The system’s response has moved beyond repeated denial and into timed quarantine. In other words, the architecture has decided that repeated unauthorized access is no longer just a policy mismatch; it is evidence of sustained hostile behavior requiring a temporary operational block.

The underlying sandbox-chain data show that the compromised subject’s security budget moved from 100 at the benign baseline to 85 after the first malicious denial, then to 75, then to 65, and finally to 25 at the point of quarantine. This budget trajectory is significant because it makes the sanction process visible. The system is not merely counting attempts; it is consuming a bounded tolerance resource that is explicitly represented on-chain.

### E. Wave 1 Recovery: Bounded Benign Restoration
After wave 1, the runner advanced chain time past the quarantine interval and executed a benign self-status access for the compromised ESP. This action succeeded, consumed 205,330 gas, and emitted `RewardIssued, StatusUpdated, BenignRecoveryApplied`. The security budget rose from 25 to 30. This is not a full reset. Instead, it is a small restoration that indicates the architecture can distinguish between a permanently malicious identity and one that is temporarily allowed back into the system after quiet behavior.

This recovery step is one of the most practically meaningful parts of the design. A large fraction of blockchain-based access-control research either denies or allows but does not specify what limited rehabilitation should look like after containment. The present architecture explicitly models it. This is particularly relevant to enterprise IoT, where administrators may prefer temporary suspension and monitored re-entry over immediate permanent decommissioning.

### F. Wave 2: Repeated Malice After Recovery
Wave 2 began after the subject had been temporarily restored. The second malicious burst produced four on-chain transactions totaling 1,086,333 gas. The same broad Judge event family appeared again, culminating in `MemberBlocked` and `QuarantineStartedOrUpdated`. The security budget trajectory reconstructed from the sandbox DB was 30 after recovery, then 15, then 5, then 0, and still 0 at the point of the second quarantine. The key insight is that the system does not forget prior damage. Recovery gives the node another opportunity, but it does not restore the node to its original position. Consequently, renewed malicious behavior leads more quickly to severe consequences.

Wave 2 demonstrates repeatability of the response mechanism. The architecture can reapply the same containment concept after a node returns from quarantine and reoffends. This is essential in real operations. A single-use sanction mechanism is not enough; hostile nodes or abusive agents often cycle through partial recovery and renewed attack.

### G. Wave 2 Recovery
As with wave 1, the runner advanced chain time and performed a benign self-status access. The action succeeded, consumed 188,230 gas, and again emitted `RewardIssued, StatusUpdated, BenignRecoveryApplied`. The security budget rose from 0 to 5. This tiny recovery is especially important because it sets up wave 3. The system is giving the subject one final narrow chance to behave benignly. The subject re-enters the system with minimal residual trust.

### H. Wave 3: Permanent Revocation
Wave 3 is the decisive phase. The `wave3_attack` action consumed 311,395 gas and required only one malicious request. The Judge events were `StatusUpdated, Penalized, PermanentRevocationTriggered, OffenseRecorded`. The reason only one request was needed is evident from the state trajectory. After two full waves and two small recoveries, the subject’s security budget had recovered only to 5, which was below any meaningful operational safety margin. One more malicious access attempt was enough to push the system into permanent containment.

This is precisely the kind of cumulative response that a behavior-aware BCAC architecture should provide. Instead of treating each access request in isolation, the system remembers the subject’s recent history and eventually concludes that further participation is unacceptable. The fact that permanent revocation happened through the same device-facing path as the earlier accesses is important. The result was not injected administratively from outside the scenario; it arose from the same bridge-to-PGH-to-contract pipeline that processed all other requests.

### I. Post-Revocation Validation
The final action attempted the same kind of lateral status access after permanent revocation. The action was denied and consumed 41,947 gas. No new Judge events were emitted, which is correct: at this point the system is not escalating; it is enforcing an already-final state. The most important result here is semantic rather than purely numeric. The node remains denied after revocation, proving that permanent containment is effective and stable.

### J. Gas Composition and Cost Interpretation
Aggregating the 25 transactions by contract reveals that provisioning dominates the gas budget. `AccessControlFactory.deployAccessControlContract` alone consumed 4,605,000 gas across the run. `AccessControlContract.accessControl` consumed 3,190,739 gas, `RoleBasedAccessControl.assignRole` consumed 1,576,718 gas, and `AccessControlContract.policyAdd` consumed 683,034 gas. This distribution has a clear operational meaning.

First, initial onboarding and contract deployment are expensive relative to later access checks. Second, repeated behavioral evaluation is cheaper than repeated full provisioning, even though it is still significant. Third, any enterprise deployment that uses a similar pattern should minimize unnecessary redeployment and take advantage of existing ACC state when possible.

At the action level, the two full ESP bootstrap actions (helper and compromised) were each more expensive than any individual malicious wave. This indicates that the architecture’s main cost center is not the Judge logic itself, but the establishment of subject-specific contract state. That is a useful design insight for practitioners considering large-scale deployment.

### K. Summary Table
Table I summarizes the logical actions and their observed on-chain characteristics in the fixed actual run.

| Stage | Logical operation | Outcome | Tx count | Gas used | Key Judge events |
|---|---|---:|---:|---:|---|
| identity_bootstrap | Role Assignment | success | 1 | 461,390 | – |
| bridge_bootstrap | ESP Telemetry Bootstrap (target) | success | 1 | 371,776 | – |
| bridge_bootstrap | ESP Telemetry Bootstrap (helper) | success | 5 | 3,015,793 | – |
| bridge_bootstrap | ESP Telemetry Bootstrap (compromised) | success | 5 | 3,015,793 | – |
| implant_checkin | Self status access | success | 1 | 175,919 | – |
| lateral_probe | Unauthorized status access | denied | 1 | 311,199 | StatusUpdated, Penalized, OffenseRecorded |
| lateral_probe | Unauthorized temperature access | denied | 1 | 267,338 | StatusUpdated, Penalized, OffenseRecorded |
| wave1_attack | Repeated malicious burst | denied | 2 | 603,048 | StatusUpdated, Penalized, OffenseRecorded, MemberBlocked, QuarantineStartedOrUpdated |
| wave1_recovery | Benign recovery | success | 1 | 205,330 | RewardIssued, StatusUpdated, BenignRecoveryApplied |
| wave2_attack | Repeated malicious burst | denied | 4 | 1,086,333 | StatusUpdated, Penalized, OffenseRecorded, MemberBlocked, QuarantineStartedOrUpdated |
| wave2_recovery | Benign recovery | success | 1 | 188,230 | RewardIssued, StatusUpdated, BenignRecoveryApplied |
| wave3_attack | Final malicious burst | denied | 1 | 311,395 | StatusUpdated, Penalized, PermanentRevocationTriggered, OffenseRecorded |
| post_revocation_validation | Lateral status re-attempt | denied | 1 | 41,947 | – |

Table II summarizes the reconstructed security-budget evolution of the compromised subject.

| Evaluate-access sequence | Result | Wave | Security budget | Blocked attempts in wave | Quarantine | Permanent revocation |
|---|---|---:|---:|---:|---|---|
| Baseline self-access | allow | 0 | 100 | 0 | no | no |
| First lateral denial | deny | 1 | 85 | 0 | no | no |
| Second lateral denial | deny | 1 | 75 | 1 | no | no |
| Burst step 1 | deny | 1 | 65 | 2 | no | no |
| Burst step 2 | deny | 1 | 25 | 3 | yes | no |
| Recovery 1 | allow | 1 | 30 | 0 | no | no |
| Wave 2 denial 1 | deny | 2 | 15 | 0 | no | no |
| Wave 2 denial 2 | deny | 2 | 5 | 1 | no | no |
| Wave 2 denial 3 | deny | 2 | 0 | 2 | no | no |
| Wave 2 denial 4 | deny | 2 | 0 | 3 | yes | no |
| Recovery 2 | allow | 2 | 5 | 0 | no | no |
| Wave 3 denial | deny | 3 | 0 | 0 | no | yes |
| Post-revocation validation | deny | 3 | 0 | 0 | no | yes |

This table clarifies the value of the security budget abstraction. It makes the JC’s internal state transitions interpretable to both engineers and non-specialists.

## VIII. Discussion
### A. What the Blockchain Actually Enforces
The results make clear that the blockchain is not a decorative log sink. It is the active enforcement layer for the scenario. Identities are assigned through the blockchain role system, ACCs are deployed on-chain, policies are stored in ACC state, access decisions are executed through `accessControl`, and Judge events are emitted on-chain in response to malicious or benign behavior. The PGH service and ESP bridge are orchestration layers, but the decisive authorization and sanction logic is anchored in smart-contract state.

This matters because a common critique of blockchain-based IoT systems is that they sometimes replicate what could have been done in a conventional database-backed policy engine. In this project, the blockchain contributes three things that are difficult to obtain from a conventional gateway alone: a tamper-evident sequence of access-control state transitions, subject-signed access-evaluation transactions, and a behavior-sensitive adjudication mechanism that is inspectable independently of the bridge.

### B. What the Local Bridge Still Contributes
The bridge remains essential. It translates MAC-level device semantics into blockchain identities, stores live telemetry, exposes simple device-like APIs, and provides the operational surface through which attacks are realistically expressed. Without the bridge, the experiment would reduce to a direct contract-interaction benchmark. Without the blockchain, it would reduce to a local-policy experiment. The architecture is useful precisely because it combines both.

The bridge also reveals an important open systems question: synchronization between local approval state and on-chain policy state must be handled carefully. In the current design, some local approval paths are mirrored to the blockchain, but not all of them are equally authoritative. This is a real deployment issue rather than a flaw in the scenario itself, and it highlights the importance of explicit provisioning semantics in enterprise environments.

### C. Security Strengths
The architecture exhibits four strong security properties.

First, it supports legitimate onboarding and legitimate access without assuming that every subject is malicious. Second, it produces auditable on-chain evidence for denied requests and sanctions instead of merely logging them in a local database. Third, it supports progressive response rather than a one-shot deny model, making it possible to represent temporary containment and later permanent revocation. Fourth, it preserves a meaningful separation between operational mediation (bridge and PGH) and enforcement/adjudication (ACC and JC).

### D. Limitations
Several limitations should be acknowledged.

1. The attack scenario uses a software bridge and a copied bridge database, not a live hardware exploit chain. This is appropriate for architectural evaluation but does not measure firmware-layer compromise techniques.
2. The system depends on an Ethereum-compatible development or private chain. The cost and timing profile would differ on a public network or a differently configured permissioned network.
3. Gas costs are dominated by provisioning, which may become material in very large fleets unless contract reuse and lifecycle management are optimized.
4. The current design still requires careful synchronization between bridge-local approvals and on-chain policy state, particularly if administrators want local approvals to imply guaranteed on-chain provisioning.
5. Privacy of policy and behavior data is not fully addressed. While the current architecture prioritizes auditability, enterprise deployments may require more use of permissioned chains, encrypted attributes, or selective disclosure techniques.

These limitations do not invalidate the experiment. They define the scope within which the results should be interpreted.

## IX. Enterprise and Industrial IoT Applicability
The architecture is highly relevant to enterprise and industrial IoT because it matches how those systems are often deployed in practice: devices are grouped into zones or clusters, gateways mediate access, multiple sites or networks coexist, and security teams need both real-time response and post-incident evidence.

In enterprise IoT, a `memberType` can represent a facility, business unit, building zone, vendor domain, or sensor family. A Primary Group Head can represent a gateway controller or local policy head. The local resource tables maintained by the blockchain role layer resemble zone-level inventories. The `RegisterContract` then becomes a registry of which subject-object relationships are formally provisioned. This is directly useful in smart campuses, logistics yards, healthcare campuses, and distributed retail systems.

In industrial IoT, the same mapping becomes even more natural. A member type can represent a production line, machine family, or process cell. A PGH can represent an industrial edge controller, OT gateway, or site security head. The ACC is then the contract that states which identity is allowed to interact with which resource surface under which action semantics. The JC becomes an incident-response component that can temporarily quarantine a misbehaving node instead of immediately removing it, allowing operations teams to verify whether the event was accidental, misconfigured, or truly malicious.

This progressive response is especially important in enterprises because not every anomaly should lead to permanent removal. Temporary quarantine, bounded recovery, and explicit permanent revocation correspond closely to actual operational-security workflows: isolate, observe, restore cautiously, and finally decommission if behavior persists.

The Poison Ivy-style evaluation strengthens the enterprise relevance argument because it does not assume that the attacker is an obviously foreign identity. Instead, it models the more uncomfortable case in which an already trusted endpoint or integration component becomes hostile. This is closer to how real incidents unfold in large organizations, where attackers often exploit trusted middleware, stolen credentials, or supply-chain footholds rather than confronting the policy engine from outside.

That said, enterprise adoption would likely require several refinements beyond the prototype-quality evaluation stack. A permissioned blockchain would often be preferable to a public chain for governance, privacy, and predictable latency. Policy synchronization between local approvals and on-chain state should be formalized. Device attestation, firmware provenance, and secure identity anchoring would strengthen the bridge-to-blockchain trust path. Finally, some ultra-low-latency industrial control loops should remain locally fail-safe rather than synchronously dependent on blockchain execution.

## X. Conclusion
This paper presented and evaluated a behavior-aware blockchain access-control architecture for clustered IoT environments. The design combines an ESP bridge, a PGH orchestration layer, and an Ethereum-based smart-contract stack comprising role management, registration, subject-object-specific access-control contracts, and a Judge Contract for behavioral adjudication. The system is not a mere access log; it is an operational enforcement framework that can grant access, deny access, penalize subjects, impose temporary quarantine, reward bounded benign recovery, and permanently revoke persistently malicious nodes.

Using a fixed actual Poison Ivy-style bridge compromise scenario run, the paper showed that a legitimate-looking ESP identity can be onboarded normally, perform benign self-access, then move through repeated unauthorized lateral access, wave-based quarantine, bounded recovery, and final permanent revocation. The run executed 13 actions and 25 real blockchain transactions, consumed 10,055,491 gas, emitted 11 penalty events and 2 reward events, and ended with successful post-revocation denial. These results demonstrate that blockchain-backed adjudication can be made concrete, measurable, and operationally meaningful in a clustered IoT context.

The contribution of this work is best understood as a systems realization and evaluation contribution. The general idea of blockchain-based IoT access control, and even the ACC/JC/RC family of smart contracts, already exists in prior literature. The present work extends that lineage by integrating it with a device-facing bridge and PGH model, implementing a more explicit staged Judge mechanism, and validating the design through an end-to-end, attack-oriented evaluation whose evidence is available at action, transaction, and scenario levels. This makes the work directly relevant to enterprise and industrial IoT settings where trustworthy enforcement, incident containment, and auditability must coexist.

## References
[1] Y. Zhang, S. Kasahara, Y. Shen, X. Jiang, and J. Wan, “Smart Contract-Based Access Control for the Internet of Things,” arXiv:1802.04410, 2018. DOI: 10.48550/arXiv.1802.04410. Available: https://arxiv.org/abs/1802.04410

[2] T. Sultana, A. Almogren, M. Akbar, M. Zuair, I. Ullah, and N. Javaid, “Data Sharing System Integrating Access Control Mechanism using Blockchain-Based Smart Contracts for IoT Devices,” *Applied Sciences*, vol. 10, no. 2, Art. no. 488, 2020. DOI: 10.3390/app10020488. Available: https://www.mdpi.com/2076-3417/10/2/488

[3] R. Xu, Y. Chen, E. Blasch, and G. Chen, “BlendCAC: A Smart Contract Enabled Decentralized Capability-Based Access Control Mechanism for the IoT,” *Computers*, vol. 7, no. 3, Art. no. 39, 2018. Available: https://www.mdpi.com/2073-431X/7/3/39

[4] G. D. Putra, V. Dedeoglu, S. S. Kanhere, and R. Jurdak, “Trust Management in Decentralized IoT Access Control System,” arXiv:1912.10247, 2020. DOI: 10.48550/arXiv.1912.10247. Available: https://arxiv.org/abs/1912.10247

[5] Y. Liu, Q. Lu, S. Chen, Q. Qu, H. O’Connor, K.-K. R. Choo, and H. Zhang, “Capability-based IoT access control using blockchain,” *Digital Communications and Networks*, vol. 7, no. 4, pp. 463–469, 2021. DOI: 10.1016/j.dcan.2020.10.004. Available: https://www.sciencedirect.com/science/article/pii/S2352864820302844

[6] O. Novo, “Blockchain Meets IoT: An Architecture for Scalable Access Management in IoT,” *IEEE Internet of Things Journal*, vol. 5, no. 2, 2018. DOI: 10.1109/JIOT.2018.2812239. Available: https://www.ericsson.com/en/reports-and-papers/research-papers/blockchain-meets-iot-an-architecture-for-scalable-access-management-in-iot

[7] A. I. Abdi, F. E. Eassa, K. Jambi, K. Almarhabi, M. Khemakhem, A. Basuhail, and M. Yamin, “Hierarchical Blockchain-Based Multi-Chaincode Access Control for Securing IoT Systems,” *Electronics*, vol. 11, no. 5, Art. no. 711, 2022. DOI: 10.3390/electronics11050711. Available: https://www.mdpi.com/2079-9292/11/5/711

[8] S. Luo, T. Hu, N. Han, and Y. Qian, “A Smart-Contract-Based Policy-Domain Access Control Framework for Distributed Industrial IoT,” *IEEE Internet of Things Journal*, vol. 11, no. 7, pp. 11427–11443, 2024. Available: https://ieeexplore.ieee.org/abstract/document/10305075

[9] P. Singh, S. Nandi, and others, “Blockchain-enabled access control to prevent cyber attacks in IoT: Systematic literature review,” *Frontiers in Big Data*, 2022. Available: https://www.frontiersin.org/journals/big-data/articles/10.3389/fdata.2022.1081770/pdf

[10] “Blockchain-based Identity and Access Management in Industrial IoT Systems,” IFIP/IM Workshop paper, 2021. Available: https://dl.ifip.org/db/conf/im/im2021short/211097.pdf

[11] S. Sun, R. Du, S. Chen, and W. Li, “Blockchain-Based IoT Access Control System: Towards Security, Lightweight, and Cross-Domain,” *IEEE Access*, vol. 9, pp. 36868–36878, 2021. DOI: 10.1109/ACCESS.2021.3059863. Available: https://doaj.org/article/d0446a97236f48bdbbff98fbee7ac723
