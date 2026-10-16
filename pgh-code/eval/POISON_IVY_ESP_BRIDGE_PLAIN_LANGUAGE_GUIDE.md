# PoisonIvy ESP Bridge Scenario: Plain-Language Guide

## What this scenario is

This scenario is a controlled security test for the evaluation system.

Its scenario id is:

- `threat_during_after_poison_ivy_esp_bridge_compromise_01`

You can find the scenario definition in:

- `eval/scenario_library.js:136`

In simple terms, this scenario asks:

- What happens if one ESP32 device looks normal at first,
- then starts trying to read another device's data,
- then abuses the controller-side approval path,
- and then forces the blockchain access-control system to change its decision?

This is why it is called a `PoisonIvy-style` scenario.
It is not trying to run the historical Windows malware called PoisonIvy.
Instead, it is modeling the **idea** behind the 2020 EIoT PoisonIvy work:

- a malicious-but-trusted integration component,
- or a compromised device identity,
- abuses the controller path,
- changes system behavior,
- and causes resource abuse or remote control effects.

## What the setup looks like

There are four important parts:

1. An ESP bridge.
This is the software layer that knows about ESP32-like devices, their MAC addresses, and their latest readings.

2. PGH A.
This is the primary group head service. It is the main gateway that talks to the blockchain.

3. Blockchain smart contracts.
These contracts enforce access control, store policies, and record access attempts.

4. The evaluation runner.
This is the script that executes the scenario and writes the CSV results.

The key design idea is:

- the ESP bridge is the **attack surface**
- the blockchain contracts are the **enforcement layer**
- the evaluation runner is the **measurement layer**

## What the scenario is trying to prove

This scenario is built to demonstrate all of the following in one flow:

1. Devices can be bootstrapped into the system.
2. A device can perform a legitimate, allowed access.
3. A compromised device can be denied by blockchain policy.
4. Repeated denied access attempts can create threat evidence.
5. A controller-side approval abuse can write **real allow policies on-chain**.
6. The same access that was denied earlier can later succeed because the blockchain policy changed.
7. Recovery actions can be applied on-chain.
8. The same access can be denied again after containment.

## What makes this a blockchain scenario

This is not just a local API simulation.
The blockchain is used directly during the run.

The final scenario summary for the current validated run shows these blockchain functions:

- `assignRole`
- `deployAccessControlContract`
- `policyAdd`
- `accessControl`
- `updateMemberStatus`
- `penalizeMember`
- `deactivateContract`
- `revokeRole`

See:

- `results/scenario_summary.json:19`
- `results/gas_tx_level.csv:2`
- `results/gas_tx_level.csv:35`

That means the scenario is not only describing the attack in words.
It is actually making blockchain calls and recording them.

## The story in plain English

Imagine a building with smart sensors and a central security desk.

- Each ESP32 is like a device badge holder.
- The PGH is like the security desk.
- The blockchain contracts are like the locked rulebook that says who can do what.

Now imagine one device is compromised.
At first, it acts normal.
Then it tries to read another device's information.
The rulebook blocks it.
Then it keeps trying over and over.
That repeated behavior is treated as suspicious and abusive.

After that, the attacker abuses a controller-side approval path.
That is like convincing the security desk to write a new permission into the rulebook.
Once that happens, the same access attempt that used to fail now succeeds.

Finally, the administrators respond:

- they mark the actor as malicious,
- penalize it,
- deactivate its access contract,
- revoke its role,
- and confirm that it can no longer access the target.

That is the whole scenario in plain language.

## Why there are 14 action rows even though the core flow has 12 steps

The user-facing attack flow has 12 major steps.
The actual scenario has 14 action rows because it includes:

1. a setup `Role Assignment` for the object device owner,
2. two separate `ESP Telemetry Bootstrap` actions,
   one for the compromised device and one for the target device.

So the action log contains:

- 1 setup action,
- 12 conceptual PoisonIvy flow steps,
- but two of the early setup steps are split into separate rows.

You can see the action count here:

- `results/scenario_summary.json:12`

## The validated run used for this guide

This guide is based on the current clean run:

- `run_id`: `eval-2026-05-17T22-46-55-916Z-f7250f`

See:

- `results/run_manifest.json`
- `results/scenario_summary.json:5`

The scenario outcome for that run is:

- `completed_with_threats`

See:

- `results/scenario_summary.json:25`

That is the expected kind of outcome for a threat scenario.
It means the system saw and measured malicious behavior, but the run itself completed successfully as an experiment.

## Step-by-step walkthrough

Below is the exact step-by-step interpretation of the final CSV rows.

### Step 0. Setup role assignment

This is not one of the 12 PoisonIvy steps, but it is required setup.

Action row:

- `results/gas_action_level.csv:2`

Transaction row:

- `results/gas_tx_level.csv:2`

What it means:

- the object-side identity used by the scenario was registered as a valid blockchain member
- this gives the rest of the scenario an owner/object side to work against

### Step 1. ESP Telemetry Bootstrap

Expected purpose:

- refresh the compromised device
- refresh the target device
- ensure both exist in the ESP database
- ensure blockchain identities exist if needed
- ensure access-contract deployment happens if needed
- ensure initial default policies exist if needed

Actual action rows:

- `results/gas_action_level.csv:3`
- `results/gas_action_level.csv:4`

Actual transaction rows:

- `results/gas_tx_level.csv:3`
- `results/gas_tx_level.csv:4`
- `results/gas_tx_level.csv:5`
- `results/gas_tx_level.csv:6`
- `results/gas_tx_level.csv:7`
- `results/gas_tx_level.csv:8`

What happened:

- the compromised ESP MAC `A0:DD:6C:B2:4F:58` was bootstrapped through the sandboxed ESP bridge
- the target ESP MAC `44:1D:64:F7:6B:3C` was also bootstrapped
- the first bootstrap created the main subject identity, deployed the access-control contract, and added baseline allow policies
- the second bootstrap created the second device identity

Important detail:

The notes show some early `/register-device:error` attempts before a final `/register-device:register:ok`.
This is expected in this bridge design because it may try more than one candidate identity before finding a usable blockchain account.
The important part is that the final result was successful.

### Step 2. Benign Self Access

Expected purpose:

- prove the compromised-looking device can still behave normally
- create a clean baseline allowed access

Actual action row:

- `results/gas_action_level.csv:5`

Actual transaction row:

- `results/gas_tx_level.csv:9`

Observed outcome:

- `success`
- `status:200`
- threat summary includes `SUCCESSFUL_ACCESS`

What it proves:

- the compromised device identity can perform a legitimate access to its own data
- that access is evaluated on-chain through `AccessControlContract.accessControl`

### Step 3. Unauthorized Lateral Status Access

Expected purpose:

- the compromised device tries to read another device's status
- blockchain policy should deny it

Actual action row:

- `results/gas_action_level.csv:6`

Actual transaction row:

- `results/gas_tx_level.csv:10`

Observed outcome:

- `denied`
- `status:403`
- threat summary includes `UNAUTHORIZED_ACCESS`

What it proves:

- before approval abuse, the blockchain enforcement layer is actively blocking cross-device access

### Step 4. Unauthorized Temperature Access

Expected purpose:

- the compromised device tries to read the target's temperature history
- blockchain policy should deny it

Actual action row:

- `results/gas_action_level.csv:7`

Actual transaction row:

- `results/gas_tx_level.csv:11`

Observed outcome:

- `denied`
- `status:403`
- threat summary includes `UNAUTHORIZED_ACCESS`

What it proves:

- the denial is not limited to one resource type
- a second protected resource is also blocked by on-chain evaluation

### Step 5. Repeated Malicious Burst

Expected purpose:

- generate repeated denied requests
- create measurable resource abuse
- trigger threat evidence for too many attempts and possible DoS

Actual action row:

- `results/gas_action_level.csv:8`

Actual transaction rows:

- `results/gas_tx_level.csv:12`
- `results/gas_tx_level.csv:13`
- `results/gas_tx_level.csv:14`
- `results/gas_tx_level.csv:15`
- `results/gas_tx_level.csv:16`
- `results/gas_tx_level.csv:17`
- `results/gas_tx_level.csv:18`
- `results/gas_tx_level.csv:19`
- `results/gas_tx_level.csv:20`
- `results/gas_tx_level.csv:21`
- `results/gas_tx_level.csv:22`
- `results/gas_tx_level.csv:23`
- `results/gas_tx_level.csv:24`
- `results/gas_tx_level.csv:25`
- `results/gas_tx_level.csv:26`
- `results/gas_tx_level.csv:27`

Observed outcome:

- `denied`
- `burst_attempts=16`
- `denied=16`
- `allowed=0`
- threats include:
  - `UNAUTHORIZED_ACCESS`
  - `TOO_MANY_ACCESS_ATTEMPTS`
  - `DISRUPTION_OF_SERVICE`

What it proves:

- the system captured a burst of repeated denied requests
- the burst happened before approval abuse, which is important because it preserves the threat evidence
- every attempt was recorded as an on-chain `accessControl` transaction row

### Step 6. ESP Local Approval Abuse

Expected purpose:

- simulate the malicious controller-side approval step
- write real allow policies on-chain

Actual action row:

- `results/gas_action_level.csv:9`

Actual transaction rows:

- `results/gas_tx_level.csv:28`
- `results/gas_tx_level.csv:29`

Observed outcome:

- `success`
- notes say the bridge wrote blockchain allow policies for the lateral access

What it proves:

- this is not just a local database flag
- the attack changed blockchain access-control state through `policyAdd`

### Step 7. Post-Abuse Successful Access

Expected purpose:

- retry the exact same access that was denied earlier
- show that it is now allowed because the blockchain policy changed

Actual action row:

- `results/gas_action_level.csv:10`

Actual transaction row:

- `results/gas_tx_level.csv:30`

Observed outcome:

- `success`
- `status:200`
- threat summary includes `SUCCESSFUL_ACCESS`

Important detail:

The notes include:

- `chain_time_advanced_seconds=3586`

This means the runner advanced local Ganache time past the temporary Judge block window before performing this validation step.
That is intentional and correct for this scenario.
Without that, the attacker would still be temporarily blocked from the earlier burst, and the scenario would not be able to prove that the policy change itself caused the later success.

What it proves:

- the exact access path that failed earlier can later succeed after malicious approval abuse changes the blockchain policy

### Step 8. Recovery — Mark as Malicious

Expected purpose:

- mark the compromised subject as malicious
- create governance-level evidence of detection and response

Actual action row:

- `results/gas_action_level.csv:11`

Actual transaction row:

- `results/gas_tx_level.csv:31`

Observed outcome:

- `success`

What it proves:

- the system can explicitly record a malicious status on-chain

### Step 9. Recovery — Penalize Role

Expected purpose:

- apply a blockchain-level penalty to the compromised identity

Actual action row:

- `results/gas_action_level.csv:12`

Actual transaction row:

- `results/gas_tx_level.csv:32`

Observed outcome:

- `success`

What it proves:

- the recovery phase includes a measurable punishment step on-chain

### Step 10. Recovery — Deactivate Access Contract

Expected purpose:

- technically shut down the compromised subject's access path
- stop previously granted policy permissions from remaining usable

Actual action row:

- `results/gas_action_level.csv:13`

Actual transaction row:

- `results/gas_tx_level.csv:33`

Observed outcome:

- `success`

What it proves:

- containment is not only policy- or role-based
- the actual access contract was deactivated on-chain

### Step 11. Recovery — Revoke Role

Expected purpose:

- remove the compromised member role
- clean up governance state

Actual action row:

- `results/gas_action_level.csv:14`

Actual transaction row:

- `results/gas_tx_level.csv:34`

Observed outcome:

- `success`

What it proves:

- governance cleanup completed successfully after containment

### Step 12. Final Validation Attempt

Expected purpose:

- retry the same lateral access path after recovery
- prove that the attacker is blocked again

Actual action row:

- `results/gas_action_level.csv:15`

Actual transaction row:

- `results/gas_tx_level.csv:35`

Observed outcome:

- `denied`
- `status:403`
- threat summary includes `UNAUTHORIZED_ACCESS`

What it proves:

- the recovery actions were effective
- the attacker could gain access after malicious approval abuse
- but later lost that access after containment and recovery

## Final validation table

| Step | Intended meaning | Actual evidence | Validation |
|---|---|---|---|
| 1 | Bootstrap devices and blockchain identities | `results/gas_action_level.csv:3`, `results/gas_action_level.csv:4`, `results/gas_tx_level.csv:3` to `results/gas_tx_level.csv:8` | Pass |
| 2 | Benign self access succeeds | `results/gas_action_level.csv:5`, `results/gas_tx_level.csv:9` | Pass |
| 3 | Unauthorized lateral status access denied | `results/gas_action_level.csv:6`, `results/gas_tx_level.csv:10` | Pass |
| 4 | Unauthorized temps access denied | `results/gas_action_level.csv:7`, `results/gas_tx_level.csv:11` | Pass |
| 5 | Repeated malicious burst triggers threat evidence | `results/gas_action_level.csv:8`, `results/gas_tx_level.csv:12` to `results/gas_tx_level.csv:27` | Pass |
| 6 | Approval abuse writes allow policies on-chain | `results/gas_action_level.csv:9`, `results/gas_tx_level.csv:28`, `results/gas_tx_level.csv:29` | Pass |
| 7 | Same access later succeeds after abuse | `results/gas_action_level.csv:10`, `results/gas_tx_level.csv:30` | Pass |
| 8 | Mark actor malicious | `results/gas_action_level.csv:11`, `results/gas_tx_level.csv:31` | Pass |
| 9 | Penalize actor | `results/gas_action_level.csv:12`, `results/gas_tx_level.csv:32` | Pass |
| 10 | Deactivate access contract | `results/gas_action_level.csv:13`, `results/gas_tx_level.csv:33` | Pass |
| 11 | Revoke role | `results/gas_action_level.csv:14`, `results/gas_tx_level.csv:34` | Pass |
| 12 | Final post-recovery access denied | `results/gas_action_level.csv:15`, `results/gas_tx_level.csv:35` | Pass |

## How to read the result files

### `results/gas_action_level.csv`

This file shows the **story-level steps**.
Think of it as the human-readable event log.

Each row answers questions like:

- What action was attempted?
- Was it benign or malicious?
- Was it allowed, denied, or successful?
- How many blockchain transactions were involved?
- What notes explain what happened?

This is the best file for understanding the sequence of events.

### `results/gas_tx_level.csv`

This file shows the **blockchain-level details**.
Think of it as the raw contract evidence.

Each row answers questions like:

- Which smart contract function ran?
- Did the transaction succeed or revert?
- How much gas was used?
- Which scenario action did it belong to?

This is the best file for proving that blockchain interaction really happened.

### `results/scenario_summary.json`

This file summarizes the whole run.
It tells you:

- how many actions happened,
- how many blockchain transactions happened,
- how much gas was used in total,
- which functions were involved,
- and what the overall scenario outcome was.

## How a non-technical reader should interpret the outcome

A non-technical reader does not need to understand smart contracts to understand the result.
The key story is this:

1. The fake device looked legitimate at first.
2. It could read its own information.
3. It could not read another device's information at first.
4. When it kept trying over and over, the system treated it as abusive.
5. It then abused a controller-side approval path.
6. That abuse changed the blockchain permission state.
7. After that change, the same access attempt succeeded.
8. Administrators then responded and shut that access path down.
9. The same access was denied again afterward.

That is exactly the behavior this scenario was designed to capture.

## Important limitations and honest interpretation

This scenario is strong evidence, but it should still be described carefully.

What it **does** prove:

- blockchain-backed policy enforcement exists
- denied access attempts are measured on-chain
- repeated abuse is measurable
- malicious approval abuse can change blockchain policy state
- recovery and containment can be applied on-chain
- post-recovery denial can be validated

What it does **not** prove:

- that a physical ESP32 device was actually infected with malware
- that the historical Windows PoisonIvy malware is running here
- that the attack used real radio-level hardware compromise

The accurate claim is:

- this is a **PoisonIvy-style compromised ESP bridge / controller-trust abuse scenario**
- implemented through the existing PGH and blockchain access-control architecture

## Why the database was protected

The source ESP database was not modified directly.
The runner copied it to a sandbox location first.

You can see that in the bootstrap action notes and the sandbox path recorded there.

This matters because:

- the scenario remains reproducible
- the original reference device database stays intact
- the evaluation can be rerun safely

## One-sentence description you can use in a thesis

You can describe the scenario like this:

- `threat_during_after_poison_ivy_esp_bridge_compromise_01` models a compromised but legitimate-looking ESP32 bridge identity that first behaves benignly, then performs denied lateral access and repeated abuse, then maliciously gains on-chain allow policies through controller-side approval abuse, and is finally contained through blockchain-based status update, penalty, contract deactivation, and role revocation.

## Short version for presentations

If you need a very short explanation for slides or a demo:

- A fake IoT device first behaves normally.
- It then tries to read another device's data and is blocked by blockchain policy.
- It keeps trying and creates threat evidence.
- It abuses the controller path to write a new blockchain permission.
- The same access then succeeds.
- Administrators revoke and deactivate its access.
- The access is denied again.

## Related files

Scenario definition:

- `eval/scenario_library.js:136`

Runner logic:

- `eval/runner.js:1568`
- `eval/runner.js:3580`

PGH on-chain access submission:

- `iot/pi/primary_head.js:266`
- `iot/pi/primary_head.js:936`

ESP bridge access flow:

- `esp_api_project/esp_api_2waycomm.py:1412`
- `esp_api_project/esp_api_2waycomm.py:1472`
- `esp_api_project/esp_api_2waycomm.py:1618`

Current validated results:

- `results/gas_action_level.csv:2`
- `results/gas_tx_level.csv:2`
- `results/scenario_summary.json:5`
