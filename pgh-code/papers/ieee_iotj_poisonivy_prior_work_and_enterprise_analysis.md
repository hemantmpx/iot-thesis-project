# Prior-Work Comparison, Novelty Boundary, and Enterprise IoT Applicability of the BCAC–Judge Architecture

**Companion analysis document for the manuscript in `papers/ieee_iotj_poisonivy_bcac_paper.md`**  
**Repository context:** `/home/mpxhemant/thesis`  
**Primary empirical evidence referenced here:** `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/`

## Executive Summary
This document positions the repository’s blockchain access-control (BCAC) architecture against prior blockchain-enabled IoT access-control literature, with particular focus on the Access Control Contract (ACC), Register Contract (RC), and Judge Contract (JC) family; behavior-aware enforcement; and enterprise/industrial applicability. The main conclusion is precise:

1. the basic idea of using ACC/RC/JC smart contracts for IoT access control is **not novel in itself**;
2. the repository’s contribution is a **systems implementation and evaluation advance** rather than a claim of first invention;
3. the most defensible novelty lies in the **integration of that contract family with a bridge-mediated, clustered IoT architecture**, a **progressive Judge state machine** with quarantine and bounded recovery, and a **reproducible Poison Ivy-style compromise evaluation** backed by actual on-chain traces; and
4. the architecture maps well to **enterprise IoT and industrial IoT (IIoT)** environments because it combines local operational mediation, blockchain-backed policy enforcement, behavior-sensitive sanctions, and auditable incident response.

The analysis below is intentionally strict. It distinguishes what is inherited from prior research, what has been materially extended in this repository, and how those differences matter for enterprise deployment.

## I. Scope of the Comparison
The comparison covers two layers.

First, it compares the **conceptual architecture** of this repository with earlier smart-contract access-control models for IoT. This includes contract decomposition, policy-management style, identity model, misbehavior handling, and enforcement semantics.

Second, it compares the **implementation depth** of this repository with prior work. Many papers propose blockchain-based access-control logic, but far fewer expose the entire operational chain from device-facing bridge APIs to gateway orchestration, contract deployment, real access transactions, and attack-run evidence at scenario, action, and transaction levels. The present repository does all of those things simultaneously.

The analysis uses the code and results in the repository as the primary artifact base, especially:

- `informational/contracts/AccessControlContract.sol`
- `informational/contracts/JudgeContract.sol`
- `informational/contracts/RegisterContract.sol`
- `informational/contracts/AccessControlFactory.sol`
- `informational/contracts/RoleBasedAccessControl.sol`
- `informational/contracts/RoleToken.sol`
- `iot/pi/primary_head.js`
- `iot/pi/threatModel.js`
- `esp_api_project/esp_api_2waycomm.py`
- `eval/scenario_library.js`
- `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/scenario_summary.json`
- `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/gas_action_level.csv`
- `results/poisonivy_actual_poisonivy-actual-fixed-20260601T180452Z/gas_tx_level.csv`

The external comparison uses peer-reviewed or primary research sources identified by web search.

## II. What This Repository Actually Implements
Before comparing the work to the literature, it is necessary to state precisely what the repository implements.

### A. Contract Family and Enforcement Flow
The smart-contract side is built around six contracts and one orchestration relationship.

- `RoleToken.sol` manages tokenized role allocation, member-type semantics, local/global resource tables, and member status.
- `RoleBasedAccessControl.sol` exposes assignment, revocation, status update, and reward/penalty operations as an administrative interface over the role-token layer.
- `RegisterContract.sol` maps `(object, subject, access-control-type)` to a deployed access-control contract address.
- `AccessControlFactory.sol` deploys subject/object-specific `AccessControlContract` instances and registers them.
- `AccessControlContract.sol` performs resource/action policy matching, request timing checks, and misbehavior forwarding.
- `JudgeContract.sol` handles per-member behavior state, sanctions, quarantine, recovery, and permanent revocation.

The operational enforcement path is:

`ESP request -> ESP bridge -> PGH -> RegisterContract lookup -> AccessControlContract.accessControl(...) -> JudgeContract state transition -> PGH containment if needed`

This is important because the blockchain is not just used for post hoc logging. It is in the active decision loop. The bridge and PGH layers mediate device-facing communication and orchestration, but the access decision and adjudication are concretized on-chain.

### B. Clustered IoT Model
The repository is not a generic web-service prototype. It encodes a clustered IoT view through:

- `memberType` allocation in `RoleToken.sol`
- differentiated roles such as primary group head (PGH), secondary group head, and regular member
- pairwise subject/object access-control contracts deployed by `AccessControlFactory.sol`
- local-vs-global member distinctions in the role layer
- an ESP bridge that manages MAC-keyed device identities and local SQLite state
- a PGH service that acts as the device-to-blockchain control plane

This cluster-aware design matters in enterprise IoT because real deployments are rarely flat. They are organized around sites, zones, cells, floors, buildings, production lines, or device domains, each of which often has a gateway or local coordinator.

### C. Behavior-Aware Judge Logic
The Judge is not a simple binary blacklist. It maintains a richer operational state:

- `waveIndex`
- `consecutiveMaliciousCount`
- `blockedAttemptCountInWave`
- `quarantineLevel`
- `quarantineUntil`
- `permanentRevoked`
- `lastMaliciousAt`
- `lastBenignAt`
- `securityTokenBudget`
- `cumulativePenalty`

The Judge also distinguishes multiple reasons for sanction, including:

- `Unauthorized access attempt`
- `Blocked repeated malicious attempt`
- `Too frequent access`
- `Denial of Service`
- `Tampering with data`
- `Privilege escalation`
- `Spoofing attempt`
- `Repudiation attempt`

This makes the system closer to a behavior-aware sanction engine than to a static access-policy evaluator.

### D. Attack-Oriented Evaluation
The repository evaluates the design with a staged Poison Ivy-style scenario. The attacker is not a random outsider but a provisioned ESP identity that:

1. is onboarded through the normal bridge and PGH path,
2. performs benign self-access,
3. attempts unauthorized lateral reads,
4. accumulates Judge penalties,
5. reaches temporary quarantine,
6. performs bounded benign recovery after quiet periods, and
7. is permanently revoked by a later attack wave.

The fixed actual run `poisonivy-actual-fixed-20260601T180452Z` produced:

- `13` logical actions,
- `25` on-chain transactions,
- `10,055,491` total gas,
- `11` Judge penalty events,
- `2` temporary quarantine events,
- `2` benign recovery reward events, and
- successful permanent revocation by the third malicious wave.

This level of result granularity is itself part of the implementation contribution.

## III. Direct Research Lineage: Where the Core ACC–JC–RC Idea Came From
The most important literature fact is that the repository’s high-level smart-contract decomposition has a clear academic lineage.

### A. Zhang et al. (2018): Smart Contract-Based Access Control for the Internet of Things
Zhang et al. proposed a framework composed of multiple access-control contracts, one judge contract, and one register contract for distributed and trustworthy IoT access control [1]. That paper is the cleanest conceptual ancestor of the contract structure in this repository. Its importance is twofold.

First, it already establishes the legitimacy of using a dedicated Judge contract alongside access-control contracts rather than embedding all behavior logic into one monolithic contract. Second, it already frames dynamic validation and misbehavior handling as part of IoT access control rather than as a separate monitoring subsystem.

**Similarity to the present repository:**

- same ACC/JC/RC family logic;
- per-subject/per-object-style access-control decomposition;
- explicit behavior-judging contract;
- distributed and trustworthy access-control objective.

**Difference from the present repository:**

- the repository operationalizes the model inside a larger ESP bridge + PGH stack;
- the repository extends the Judge into a multi-wave state machine with security budget, quarantine, recovery, and permanent revocation;
- the repository produces transaction-level experimental evidence for a staged compromise scenario;
- the repository explicitly integrates gateway-side containment with on-chain adjudication.

This means the present work should be described as an **implementation and extension of the Zhang-style contract family**, not as a new theoretical invention of that family.

### B. Sultana et al. (2020): Data Sharing System Integrating Access Control Mechanism Using Blockchain-Based Smart Contracts for IoT Devices
Sultana et al. proposed a blockchain-based data-sharing and access-control system that also used multiple smart contracts including ACC, RC, and JC [2]. Their abstract explicitly states that ACC manages overall access control, RC authenticates users, and JC implements behavior judging and defines penalties after misbehavior detection.

This is the second major lineage point because it reinforces that the ACC/RC/JC split is not unique to this repository and has already been carried into practical IoT data-sharing research.

**Similarity to the present repository:**

- contract decomposition strongly overlaps;
- behavior judging is treated as part of the access-control system;
- performance discussion includes smart-contract cost.

**Difference from the present repository:**

- the repository models clustered IoT with PGH and bridge layers;
- the repository has stronger behavior-state semantics, including repeated blocked attempts, wave-based quarantine, and bounded recovery;
- the repository evaluates an explicit, reproducible attack narrative rather than mostly reporting a generic contract-cost profile;
- the repository captures action-level, transaction-level, and scenario-level evidence with real attack staging.

### C. Abdi et al. (2022): Hierarchical Blockchain-Based Multi-Chaincode Access Control for Securing IoT Systems
Abdi et al. extended the ACC/JC/RC family into a hierarchical blockchain and multi-chaincode setting [7]. That paper matters because it shows the broader literature has already explored both the contract family and scaled variations of it.

**Similarity to the present repository:**

- ACC/JC/RC decomposition again appears;
- concern with both static and dynamic permission validation;
- focus on distributed IoT security.

**Difference from the present repository:**

- their emphasis is hierarchical chaincode structure and attribute-based permissions;
- the repository emphasizes a gateway-mediated Ethereum implementation, staged Judge behavior, and attack-run evaluation;
- the repository’s novelty is more operational and behavioral than hierarchical or chaincode-centric.

### D. Implication of the Direct Lineage
These three works together make the novelty boundary clear. The repository cannot honestly claim to be the first BCAC system with access-control contracts, a register contract, and a judge-like contract. That claim would be false.

What the repository can claim, accurately, is that it:

- takes that family seriously as a deployable software architecture;
- extends the Judge semantics to support progressive incident response;
- integrates the contract family with bridge and gateway services used to manage clustered device populations; and
- validates the design with a concrete compromise scenario backed by actual on-chain traces.

That is a strong contribution, but it is a different type of contribution.

## IV. Comparison with Other Blockchain-IoT Access-Control Lines
Beyond the direct ACC/JC/RC lineage, the literature contains several other design families.

### A. Capability-Based Lines
BlendCAC [3] and Liu et al.’s capability-based IoT access control using blockchain [5] focus on decentralized capability or delegation structures. These systems are valuable because they address scalability, domain delegation, and fine-grained authorization without relying solely on role tables.

**Where this repository is similar:**

- distributed access-control state;
- smart-contract mediation;
- fine-grained resource/action semantics;
- concern for large-scale IoT.

**Where it is different:**

- capability-based systems primarily emphasize who possesses a transferable or delegated right;
- the repository emphasizes what happens after a legitimate subject becomes malicious;
- the Judge in this repository is a persistent behavior-state machine, not simply a token/capability verifier.

This difference is important in enterprise settings. Capability systems are strong for scalable decentralized delegation. The repository is stronger when the main risk is a provisioned device that begins misbehaving after legitimate onboarding.

### B. Attribute-Based and Policy-Domain Lines
Several blockchain-based IoT access-control works move toward attribute-based or domain-based models rather than role-plus-judge decomposition. Examples include non-interactive blockchain ABAC approaches [10], policy-domain access control for distributed industrial IoT [8], and other domain attribute-based proposals.

These systems are relevant because enterprise and industrial environments often require contextual or domain-sensitive authorization rather than only subject/object pairs.

**Where this repository is similar:**

- policy distribution is moved to smart contracts;
- authorization is externally auditable;
- the system can differentiate resources and actions rather than using a single coarse permission bit.

**Where it is different:**

- the repository does not implement a full enterprise ABAC language;
- instead, it focuses on pairwise resource/action rules combined with Judge-driven behavioral adaptation;
- the enterprise strength of this design is not policy expressiveness alone, but coordinated sanctioning and containment.

For enterprise IoT, this means the present architecture is well suited to environments where devices are cluster-owned and gateway-mediated, but it may require future work if the deployment demands rich multi-attribute, time-space-context access policies.

### C. Trust and Reputation Lines
Putra et al. [4] emphasized that dynamic device behavior matters and proposed blockchain-enabled trust management for decentralized IoT access control. This line is very close to the motivation of the repository.

**Where this repository is similar:**

- both recognize that static identity and policy are not enough;
- both treat device behavior over time as security-relevant;
- both push trust-management or behavior-management logic into a blockchain context.

**Where it is different:**

- many trust/reputation systems use numeric trust scores or interaction histories to influence later authorization;
- the repository instead implements explicit operational sanctions: penalty, quarantine, bounded recovery, and permanent revocation;
- the repository ties those sanctions to an actual subject-signed access-control path, not only to abstract trust recalculation.

This makes the repository especially useful when operational containment matters more than trust-score interpretation.

### D. IIoT and Enterprise-Oriented Access-Control Lines
Industrial and enterprise IoT works such as Novo [6], Luo et al. [8], Feng et al. [12], DHACS [13], and blockchain-based identity and access management for industrial IoT [14] address the reality that IoT deployments are organizationally distributed and often mediated by gateways, domains, orderers, or control heads.

The repository is closest to these works in deployment spirit. It is not merely a smart-home proof of concept. It includes:

- a gateway-style PGH;
- an ESP bridge that stands between local device interactions and blockchain state;
- contract lookup, deployment, and enforcement orchestration;
- progressive behavior response for already registered participants.

**Where this repository is similar:**

- it supports distributed management of clustered devices;
- it decouples local device interactions from blockchain contract execution;
- it is naturally applicable to multi-domain or multi-cluster environments.

**Where it is different:**

- many IIoT papers focus on policy scalability, identity federation, or consensus structure;
- the repository places more emphasis on behavior-aware response and attack-driven validation;
- the repository specifically demonstrates repeated malicious waves, timed quarantine, recovery, and permanent revocation against a bridge-mediated attacker identity.

## V. Comparative Matrix
Table 1 summarizes the relationship between representative works and the present repository.

| Work | Primary model | Behavior-aware sanctioning | Gateway/bridge integration | Cluster or domain orientation | Attack-oriented evaluation | Relation to this repository |
| --- | --- | --- | --- | --- | --- | --- |
| Zhang et al. 2018 [1] | ACC/JC/RC smart-contract framework | Yes, via JC | Not emphasized as full device bridge stack | Limited in published architecture | Conceptual/prototype | Direct conceptual ancestor |
| Sultana et al. 2020 [2] | ACC/RC/JC for IoT data sharing | Yes, via JC penalties | Limited bridge emphasis | D2D and data sharing orientation | Contract-cost evaluation | Strong lineage overlap |
| BlendCAC 2018 [3] | Capability-based decentralized access control | Not centered on sanction engine | Edge/domain coordinator present | Yes | Prototype evaluation | Similar decentralization goal, different security focus |
| Putra et al. 2020 [4] | Blockchain trust/reputation for IoT AC | Yes, trust-aware | Less focused on bridge stack | Distributed IoT | Trust-oriented evaluation | Similar dynamic-behavior concern |
| Liu et al. 2021 [5] | Capability-based BCAC with DIDs | Limited sanction emphasis | Identity-centric | Scalable IoT | Protocol/system evaluation | Similar decentralization, different incident model |
| Novo 2018 [6] | Scalable blockchain IoT access management | Limited behavior sanctioning | Architecture-level | Strong scalability orientation | Architecture/performance focus | Similar distributed-management motivation |
| Abdi et al. 2022 [7] | Hierarchical multi-chaincode ACC/JC/RC | Yes | No full ESP bridge/PGH stack | Strong hierarchical orientation | Contract/chaincode evaluation | Structural relative with different implementation target |
| Luo et al. 2024 [8] | Policy-domain IIoT access control | Policy-centric | Industrial domain emphasis | Strong | IIoT-focused evaluation | Similar enterprise relevance, less Judge-state focus |
| Feng et al. 2021 [12] | Consortium blockchain IIoT access control with credit evaluation | Yes, via credit chaincode | Industrial orchestration | Strong | IIoT evaluation | Similar enterprise flavor, different contract semantics |
| DHACS 2022 [13] | Hybrid access control for IIoT | Hybrid, less explicit Judge-state machine | Industrial setting | Strong | IIoT design/evaluation | Similar enterprise focus, different sanction model |
| This repository | Role/token + ACC/RC/JC + PGH + ESP bridge | Yes: penalties, quarantine, recovery, permanent revocation | Yes, explicit bridge and PGH stack | Yes, clustered IoT | Yes, reproducible Poison Ivy-style scenario with actual traces | Systems implementation and evaluation contribution |

## VI. What Is Actually Novel Here
A rigorous novelty statement should be framed in layers.

### A. Not Novel: Blockchain Access Control for IoT
Blockchain-based access control for IoT has extensive prior literature [3], [5], [6], [9], [10], [11]. This repository does not invent that field.

### B. Not Novel: The Basic ACC–JC–RC Family
The presence of multiple ACCs plus a Judge Contract and Register Contract is already explicit in earlier work [1], [2], [7]. This repository does not invent that family.

### C. Potentially Novel or at Least Distinctive: This Repository’s Specific Combination
The most defensible novelty claims are the following.

#### 1. End-to-End Clustered Implementation Rather Than Isolated Contract Proposal
The repository implements the architecture through a real device-oriented stack: ESP bridge, PGH, role layer, factory, register, per-pair ACCs, and Judge. Many papers stop at contract design or small demonstrations. This repository ties those elements together into a reproducible working system.

#### 2. Explicit Behavior-Aware Judge State Machine
The present `JudgeContract.sol` is more operationally explicit than many prior Judge-like or reputation-like proposals. The security budget, blocked-attempt counting, wave index, timed quarantine, bounded benign recovery, and permanent revocation combine to create a staged incident-response model instead of a generic trust score or one-shot penalty.

#### 3. Bridge-Mediated Adversary Model
The architecture is evaluated through an attacker that abuses a legitimate bridge-mediated IoT identity. That is closer to how enterprise and IIoT compromises often appear than a purely abstract unauthorized caller. The bridge remains operationally realistic because it carries local state, provisioning flows, and local policy checks while still forcing critical decisions through the blockchain.

#### 4. Multi-Level Reproducible Evidence
The repository generates action-level, transaction-level, and scenario-level evidence from actual runs. The fixed actual Poison Ivy run shows not just that a contract can deny a request, but how repeated denials, quarantine, recovery, and revocation appear in concrete transactions, Judge event lists, gas consumption, and per-wave outcomes.

#### 5. Integration of On-Chain Adjudication with Gateway-Side Containment
The blockchain records the sanction state, but the PGH can operationally complete containment by deactivating the ACC and revoking the role after permanent revocation. This combination is closer to enterprise response requirements than a contract-only design.

### D. Recommended Novelty Wording for the Paper or Defense
A safe and strong wording is:

> The novelty of this work lies not in proposing blockchain access control for IoT for the first time, nor in inventing the ACC/JC/RC family of smart contracts, but in implementing a behavior-aware, clustered-IoT realization of that model that integrates bridge-level device mediation, gateway orchestration, progressive on-chain sanctions, bounded recovery, and a reproducible Poison Ivy-style attack evaluation using actual transaction traces.

That statement is defensible against the literature.

## VII. How the Fixed Poison Ivy Run Strengthens the Research Claim
The fixed actual run matters because it turns the repository from a design claim into a behaviorally validated system artifact.

### A. What the Run Demonstrates
The actual run shows the following sequence:

1. the attacker is provisioned as a legitimate-looking ESP identity;
2. benign self-access succeeds first;
3. unauthorized lateral access attempts are denied and penalized on-chain;
4. repeated hostile attempts trigger temporary quarantine;
5. benign recovery is possible after the quiet period;
6. the attacker can relapse and be quarantined again;
7. later relapse reaches permanent revocation; and
8. a final validation request proves continued denial after revocation.

This is a substantially stronger claim than “the smart contract can deny an unauthorized request.” It shows that the access-control architecture has an operational memory of behavior and can change its response over time.

### B. Why This Matters Relative to Prior Work
Many prior blockchain-IoT access-control papers evaluate smart-contract gas, authorization latency, or static access decisions. Those metrics are valuable, but they do not by themselves show whether the system can manage a compromised but legitimate-seeming device across multiple waves of abuse.

The fixed actual run provides precisely that missing evidence. It is therefore central to the work’s implementation contribution. Even if individual ingredients are known from the literature, the attack-run evidence shows the design functioning as a coherent whole.

### C. Why the Results Are Enterprise-Relevant
Enterprise defenders rarely need only a static allow/deny decision. They need:

- evidence of hostile use of legitimate identities;
- escalation from denial to containment;
- audit trails suitable for incident review;
- a way to let a device recover temporarily when appropriate;
- a way to revoke permanently when abuse persists.

The fixed actual run demonstrates all of those behaviors in one scenario. That is a meaningful practical contribution.

## VIII. Enterprise IoT Applicability
### A. Why This Architecture Fits Enterprise IoT Better Than Many Academic Prototypes
Enterprise IoT systems are usually mediated by gateways, brokers, edge agents, or protocol translators. Devices do not typically interact directly with a ledger in raw form. They interact through intermediary software that performs normalization, protocol conversion, caching, and operational checks.

The repository’s ESP bridge and PGH layers already reflect that reality. The blockchain is not expected to speak directly to constrained endpoints. Instead:

- the bridge maps MAC-keyed device identities to operational state,
- the PGH handles provisioning, evaluation, and containment orchestration,
- the blockchain stores and enforces the access-control and sanction state.

This division of labor is realistic for enterprise IoT.

### B. Concrete Enterprise Deployment Mapping
The architecture can be mapped to enterprise settings as follows.

- `ESP32 or MAC-keyed device` -> industrial sensor, PLC-adjacent collector, badge reader, metering node, smart-building device, logistics tracker, or edge camera.
- `ESP bridge` -> protocol bridge, device broker, middleware adapter, OT/IT translator, local collector, or site edge service.
- `PGH` -> site gateway, zone controller, line supervisor, cell orchestrator, edge management server, or trust coordinator.
- `ACC` -> pairwise policy contract governing one device/resource relationship or one site-local trust boundary.
- `Judge` -> enterprise behavioral response contract that records offense state and drives automated containment policy.

This mapping is credible because the repository already implements the operational behaviors that such environments need: onboarding, local-to-chain mediation, repeated-access observation, timed containment, and irreversible removal.

### C. Security Benefits in Enterprise IoT
The architecture offers several enterprise benefits.

#### 1. Auditable Incident Response
Because sanctions are emitted as Judge events and recorded on-chain, security teams gain an immutable incident trail. This matters for regulated environments and for internal accountability.

#### 2. Containment of Legitimate-Identity Abuse
Enterprise breaches frequently involve valid identities or trusted middleware rather than anonymous outsiders. The repository is specifically strong against that pattern because the attack scenario itself is built around a legitimate-looking, provisioned identity that later becomes malicious.

#### 3. Cluster-Aware Policy Boundaries
The use of subject/object-specific ACCs and member-type logic gives a natural fit for segmented industrial or enterprise environments, where access is often site-local or domain-local rather than global.

#### 4. Progressive Enforcement Rather Than Static Denial
The Judge moves the system from denial to sanction, then to temporary quarantine, bounded recovery, and permanent revocation. That progression is useful in enterprise operations because not every anomaly should cause immediate permanent exclusion, yet repeated abuse should not remain tolerated indefinitely.

#### 5. Gateway–Blockchain Cooperation
Many enterprise designs fail by trying to make the blockchain do everything or by making the gateway the sole policy authority. This repository uses a pragmatic middle path: gateway mediation with blockchain-backed authoritative sanctioning.

### D. Why the Security Budget Is Useful in Enterprise Operations
The `securityTokenBudget` is a particularly helpful operational concept. It is not a replacement for the economic `RoleToken` balance. Instead, it provides a human-readable, bounded operational-security score for a participant.

That has several enterprise advantages:

- SOC or plant-security analysts can understand degradation at a glance;
- policy can be tied to visible thresholds rather than opaque raw token balances;
- temporary recovery can be expressed as bounded improvement rather than full absolution;
- repeated malicious waves can be explained clearly to auditors and supervisors.

In large enterprises, this kind of bounded operational risk budget is often easier to reason about than unbounded penalty history alone.

### E. Likely Enterprise Use Cases
The design is especially relevant to:

- smart manufacturing cells with local gateways and shared machine data;
- smart buildings where floor-level or subsystem-level gateways mediate access;
- logistics and warehousing systems with scanners, sensors, and edge controllers;
- energy and utility environments with segmented field devices;
- campus-scale sensing networks with cross-building or cross-zone restrictions.

In each case, the relevant threat is often the same: a device or local controller already appears authorized, but later starts requesting data or services beyond its legitimate scope.

## IX. Limits, Risks, and Required Maturity for Enterprise Adoption
A strong research comparison should also state what still needs work.

### A. Local–Blockchain Synchronization Needs Hardening
The repository already distinguishes local bridge approvals from on-chain policy state. That is operationally realistic, but it creates synchronization risk. Enterprise adoption would benefit from mandatory local-to-chain reconciliation for approval flows, policy-delete support, and more explicit pending-sync state management.

### B. Policy Expressiveness Is Still Moderate
The repository’s policy model is resource/action/permission oriented and pairwise, which is enough for many device-cluster scenarios. However, some enterprise environments require richer contextual attributes, separation of duties, geography, time windows, regulatory tags, or data classifications.

### C. The Threat Engine and Judge Are Stronger for Behavioral Containment Than for Rich Forensics
The Judge is effective for operational sanctioning. It is not a full forensic analytics platform. Enterprises may want to integrate the sanction output with SIEM, UEBA, SOAR, or digital-twin monitoring layers.

### D. Gas Cost and Deployment Model Matter
The fixed actual run consumed over ten million gas across 25 transactions. That is acceptable for a controlled experimental/private-chain evaluation, but enterprise deployment would need careful transaction batching, policy lifecycle management, and possibly permissioned-chain optimization.

### E. The Helper Device Footprint Shows Provisioning Overhead
The scenario bootstraps a helper device that is not later attacked. That is a realistic cluster-population choice, but it also reveals that full device provisioning carries nontrivial gas cost. Production deployment would likely need more selective provisioning strategies or long-lived state reuse.

## X. Final Assessment
The repository occupies a credible and useful position in the literature.

It is **not** the first blockchain IoT access-control proposal. It is **not** the first design to use Access Control Contracts, a Register Contract, and a Judge Contract. Several papers had already established those concepts. However, the repository is stronger than a simple reproduction. It integrates the contract family into a realistic bridge-and-gateway stack, extends the Judge into a structured sanction-and-recovery mechanism, and validates the behavior through an actual staged compromise run rather than only through generic contract-cost discussion.

The strongest scholarly claim is therefore this:

- prior work established the conceptual legitimacy of ACC/JC/RC-style blockchain access control;
- this repository advances that line by demonstrating how such a model can be operationalized for clustered IoT, behaviorally extended, and empirically evaluated through a bridge-mediated Poison Ivy-style compromise scenario.

For enterprise IoT, that is significant. Enterprises do not merely need decentralized policy storage. They need a system that can onboard devices, enforce access, notice repeated abuse by legitimate identities, quarantine those identities, permit bounded recovery where appropriate, and irreversibly revoke them when required. This repository shows a concrete path toward that goal.

## References
[1] Y. Zhang, S. Kasahara, Y. Shen, X. Jiang, and J. Wan, “Smart Contract-Based Access Control for the Internet of Things,” arXiv:1802.04410, 2018. DOI: 10.48550/arXiv.1802.04410. Available: https://arxiv.org/abs/1802.04410

[2] T. Sultana, A. Almogren, M. Akbar, M. Zuair, I. Ullah, and N. Javaid, “Data Sharing System Integrating Access Control Mechanism using Blockchain-Based Smart Contracts for IoT Devices,” *Applied Sciences*, vol. 10, no. 2, Art. no. 488, 2020. DOI: 10.3390/app10020488. Available: https://www.mdpi.com/2076-3417/10/2/488

[3] R. Xu, Y. Chen, E. Blasch, and G. Chen, “BlendCAC: A Smart Contract Enabled Decentralized Capability-Based Access Control Mechanism for the IoT,” *Computers*, vol. 7, no. 3, Art. no. 39, 2018. DOI: 10.3390/computers7030039. Available: https://www.mdpi.com/2073-431X/7/3/39

[4] G. D. Putra, V. Dedeoglu, S. S. Kanhere, and R. Jurdak, “Trust Management in Decentralized IoT Access Control System,” arXiv:1912.10247, 2020. DOI: 10.48550/arXiv.1912.10247. Available: https://arxiv.org/abs/1912.10247

[5] Y. Liu, Q. Lu, S. Chen, Q. Qu, H. O’Connor, K.-K. R. Choo, and H. Zhang, “Capability-based IoT access control using blockchain,” *Digital Communications and Networks*, vol. 7, no. 4, pp. 463–469, 2021. DOI: 10.1016/j.dcan.2020.10.004. Available: https://www.sciencedirect.com/science/article/pii/S2352864820302844

[6] O. Novo, “Blockchain Meets IoT: An Architecture for Scalable Access Management in IoT,” *IEEE Internet of Things Journal*, vol. 5, no. 2, pp. 1184–1195, 2018. DOI: 10.1109/JIOT.2018.2812239. Available: https://www.ericsson.com/en/reports-and-papers/research-papers/blockchain-meets-iot-an-architecture-for-scalable-access-management-in-iot

[7] A. I. Abdi, F. E. Eassa, K. Jambi, K. Almarhabi, M. Khemakhem, A. Basuhail, and M. Yamin, “Hierarchical Blockchain-Based Multi-Chaincode Access Control for Securing IoT Systems,” *Electronics*, vol. 11, no. 5, Art. no. 711, 2022. DOI: 10.3390/electronics11050711. Available: https://www.mdpi.com/2079-9292/11/5/711

[8] S. Luo, T. Hu, N. Han, and Y. Qian, “A Smart-Contract-Based Policy-Domain Access Control Framework for Distributed Industrial IoT,” *IEEE Internet of Things Journal*, vol. 11, no. 7, pp. 11427–11443, 2024. Available: https://ieeexplore.ieee.org/abstract/document/10305075

[9] N. Naoui and M. A. Serhani, “Blockchain-Based Access Control Techniques for IoT Applications,” *Electronics*, vol. 11, no. 14, Art. no. 2225, 2022. DOI: 10.3390/electronics11142225. Available: https://www.mdpi.com/2079-9292/11/14/2225

[10] X. Zhang, X. Zhao, Y. Shao, and others, “A Non-Interactive Attribute-Based Access Control Scheme by Blockchain for IoT,” *Electronics*, vol. 10, no. 15, Art. no. 1855, 2021. DOI: 10.3390/electronics10151855. Available: https://www.mdpi.com/2079-9292/10/15/1855

[11] S. Sun, R. Du, S. Chen, and W. Li, “Blockchain-Based IoT Access Control System: Towards Security, Lightweight, and Cross-Domain,” *IEEE Access*, vol. 9, pp. 36868–36878, 2021. DOI: 10.1109/ACCESS.2021.3059863. Available: https://doaj.org/article/d0446a97236f48bdbbff98fbee7ac723

[12] Y. Feng, W. Zhang, H. He, Y. Chen, and B. Zhang, “A Consortium Blockchain-Based Access Control Framework With Dynamic Orderer Node Selection for 5G-Enabled Industrial IoT,” *IEEE Transactions on Industrial Informatics*, vol. 18, no. 4, pp. 2840–2848, 2022. DOI: 10.1109/TII.2021.3078183. Available: https://research.polyu.edu.hk/en/publications/a-consortium-blockchain-based-access-control-framework-with-dynam

[13] R. Saha, G. Kumar, M. Conti, T. Devgun, T.-H. Kim, M. Alazab, and R. Thomas, “DHACS: Smart Contract-Based Decentralized Hybrid Access Control for Industrial Internet-of-Things,” *IEEE Transactions on Industrial Informatics*, vol. 18, no. 5, pp. 3452–3461, 2022. DOI: 10.1109/TII.2021.3108676. Available: https://cir.nii.ac.jp/crid/1360869863323631360

[14] “Blockchain-based Identity and Access Management in Industrial IoT Systems,” IFIP/IM Workshop paper, 2021. Available: https://dl.ifip.org/db/conf/im/im2021short/211097.pdf
