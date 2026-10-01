---
name: mule-runtime
description: Set up and run a MuleSoft Mule 4 runtime in this QM sandbox. Installs Temurin 17, Maven and Mule Kernel (Community Edition) 4.12.0 into the home directory (no apt, every download checksum-pinned, skipped if already there), runs Mule in the foreground with the background tool so the sprite stays awake, deploys app jars and runs a hello-world HTTP smoke test. Also covers Mule Enterprise from a zip and licence the user supplies (or MuleSoft's 30-day trial). Use when someone asks to install, run, test or deploy to Mule or MuleSoft in a session.
scope: org
---

# Mule runtime in a QM sandbox

Helper: `skills/mule-runtime/scripts/mule.sh`. Run `bash skills/mule-runtime/scripts/mule.sh` with no arguments for usage.

What it installs (all under `$HOME`, which persists on the sprite disk):

| Item | Where | Source |
| --- | --- | --- |
| Eclipse Temurin JDK 17.0.20.1+1 | `~/jdk17` | github.com/adoptium (sha256 pinned) |
| Apache Maven 3.9.16 | `~/apache-maven-3.9.16` | archive.apache.org (sha512 pinned) |
| Mule Kernel (CE) 4.12.0 | `~/mule-standalone-4.12.0` | repository.mulesoft.org public releases (sha256 pinned) |
| Env file | `~/.mule-runtime.env` | sets `JAVA_HOME`, `MAVEN_HOME`, `MULE_HOME`, `PATH` |
| Hello-world app | `~/mule-hello` | `skills/mule-runtime/assets/hello-mule` |

Measured on an R3 sprite (8 vCPU, about 7 GB free RAM): Mule with the hello app used about 1.3 GB RSS (default 1 GB heap, pre-touched), first HTTP 200 about 9 s after start, about 7 s on restart. The first Maven build downloads about 200 MB into `~/.m2`; later builds take seconds.

## Rules

1. Java 17 only. The sprite's default `java` is a newer JDK that Mule 4.12 does not support. Always use `mule.sh` (it sets `JAVA_HOME=~/jdk17`) or `. ~/.mule-runtime.env` before running `java`, `mvn` or `bin/mule` yourself.
2. Do not use `apt` for Java or Maven. It works but took about 21 minutes on a sprite because of slow package post-install steps; the tarballs take seconds.
3. Run Mule only with the `background` tool and `mule.sh run` (that is `bin/mule console` in the foreground). Do not use `bin/mule start`, `nohup` or `&`: Mule would detach, nothing would hold the sprite awake, and it would freeze whenever the sprite idles.
4. Background jobs stop at their time limit (at most 3600 s) and every process is gone after a cold wake or a sandbox restart. Before you use Mule, run `mule.sh status`; if it says NOT running, start it again (step 3). Deployed apps stay in `$MULE_HOME/apps` and redeploy on start.
5. Never invent, copy from the internet, or patch around a Mule Enterprise licence. Enterprise is used only with a zip and licence the user supplies, or under MuleSoft's own trial terms (see Enterprise below).
6. Do not create MuleSoft or Salesforce accounts, or fill in MuleSoft download or trial forms, for the user. Ask them to download the file and give it to you.
7. Mule listens on `localhost` ports inside the sandbox (hello-world uses 8081). Do not expose it publicly or change the sprite URL settings unless the user asks.

## Steps (Mule Kernel CE 4.12.0)

1. Set up. It can take a few minutes on a new sandbox (the first Maven build), so use the `background` tool, not `execute`:

   - `background` action=start, purpose "Set up Mule", timeout_seconds 1800, command:
     `bash skills/mule-runtime/scripts/mule.sh setup`
   - Then `watch` (or `poll` with wait_seconds 60) until it exits. Success ends with `setup done`.

   Options: `--heap MB` sets the JVM heap (256 to 6144, default 1024 from Mule), `--no-prefill` skips the hello-world build that fills `~/.m2`. Setup is idempotent: anything already installed is skipped, so rerun it freely.

2. Check: `execute` `bash skills/mule-runtime/scripts/mule.sh status` (exit 5 means installed but not running, which is expected now).

3. Start Mule (foreground, kept alive by the background tool):

   - `background` action=start, purpose "Run Mule runtime", timeout_seconds 3600, command:
     `bash skills/mule-runtime/scripts/mule.sh run`
   - Poll once with wait_seconds 30 and look for `Mule is up and kicking`. Exit 7 means Mule was already running; that is fine.

4. Smoke test: `execute` `bash skills/mule-runtime/scripts/mule.sh smoke`. It deploys hello-world (if needed) and expects `SMOKE OK: GET http://localhost:8081/hello -> "Hello from Mule on a QM sprite"`. Report the line and the memory figures it prints.

5. Deploy a real app: build it with Maven (`. ~/.mule-runtime.env && cd APP && mvn -B package`; the app needs `packaging` `mule-application`, mule-maven-plugin 4.10.0 or later and `minMuleVersion` no higher than the runtime), then `bash skills/mule-runtime/scripts/mule.sh deploy target/APP-mule-application.jar`. On failure read `mule.sh logs 200` and the app log in `$MULE_HOME/logs/`.

6. Stop: `background` action=stop on the run job (Mule shuts down cleanly on TERM), or `mule.sh stop`.

Heap later: `mule.sh heap 512` edits `wrapper.java.initmemory` and `wrapper.java.maxmemory` in `$MULE_HOME/conf/wrapper.conf` (original kept as `wrapper.conf.orig`); stop and start Mule to apply. Lower heap leaves more room for builds and other work.

## After a cold wake or sandbox restart

Run `mule.sh status`. If NOT running, repeat step 3, then `mule.sh smoke` or curl your app. Nothing needs reinstalling; the env file, JDK, Maven, Mule and `~/.m2` are on disk.

## Enterprise (EE)

Mule Kernel CE has no patch releases after 4.12.0 on the public repository. Enterprise builds such as 4.12.1 (`mule-ee-distribution-standalone-4.12.1-*.zip` or `mule-enterprise-standalone-*.zip`) are only on the MuleSoft Support portal (help.mulesoft.com) or from MuleSoft directly, and they need a licence.

1. Ask the user for the EE zip and, if they have one, their licence file (`.lic`). They download these themselves. Save them to a workspace path; never paste a licence into chat or a public channel.
2. Set up with the zip (and licence if given):
   `bash skills/mule-runtime/scripts/mule.sh setup --ee-zip PATH/TO/mule-ee.zip --license PATH/TO/license.lic`
   This unzips into `$HOME`, points `MULE_HOME` at it, runs `bin/mule -installLicense` with the supplied file (Mule must be stopped), prints `Evaluation = ...` and `Expiration Date = ...` from `bin/mule -verifyLicense`, and builds hello-world against the EE version. `mule.sh license-info` shows the same later (Mule stopped). Do not post the licence contact details anywhere.
3. No licence: leave out `--license`. MuleSoft documents a trial of Enterprise for evaluation that limits usage and is not for production. Tell the user plainly that it is running on trial terms, report what `mule.sh license-info` and the startup log say about the licence, and do not use it for production or client work.
4. Then follow steps 3 to 6 above. To go back to CE, run `mule.sh setup` without `--ee-zip`.

Tested on R3 (1 Oct 2026): `mule.sh setup` for CE ran end to end on a sprite with this script (116 s, rerun 1 s); Mule start, hello-world deploy and curl were tested by hand with the same commands. The EE path has not been run on R3 (no EE zip was available).

## Licensing

- Mule Kernel CE is under the Common Public Attribution License (CPAL). Fine for development and tests; check CPAL before shipping it.
- Mule Enterprise needs a MuleSoft licence for anything beyond the trial.
- Temurin is GPLv2 with Classpath Exception; Maven is Apache 2.0.

## Exit codes

0 ok, 2 usage, 3 download or checksum failure (do not bypass the checksum; report it), 4 not installed, 5 Mule not running, 6 deploy or smoke failure, 7 Mule already running.
