// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Ableton Platform Build
// smithers-description: Durable, serial build-and-review workflow for the comprehensive Ableton MCP platform.
// smithers-tags: ableton, mcp, durability, safety, pr
/** @jsxImportSource smithers-orchestrator */
import { HumanTask, Saga, UI, type AgentLike, createSmithers } from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import type { ComponentType, ReactNode } from "react";
import { z } from "zod/v4";
import { abletonAgents } from "../agents";
import ArchitectureDesignPrompt from "../prompts/ableton-platform-build/architecture-design.mdx";
import ArchitecturePlatformCritiquePrompt from "../prompts/ableton-platform-build/architecture-platform-critique.mdx";
import ArchitectureRealtimeCritiquePrompt from "../prompts/ableton-platform-build/architecture-realtime-critique.mdx";
import ArchitectureRepairPrompt from "../prompts/ableton-platform-build/architecture-repair.mdx";
import ArchitectureSecurityCritiquePrompt from "../prompts/ableton-platform-build/architecture-security-critique.mdx";
import ArchitectureVerdictPrompt from "../prompts/ableton-platform-build/architecture-verdict.mdx";
import AuditIntegrityPrompt from "../prompts/ableton-platform-build/audit-integrity.mdx";
import AuditModerationPrompt from "../prompts/ableton-platform-build/audit-moderation.mdx";
import AuditRemediationPrompt from "../prompts/ableton-platform-build/audit-remediation.mdx";
import AuditRequirementsPrompt from "../prompts/ableton-platform-build/audit-requirements.mdx";
import AuditSafetyPrompt from "../prompts/ableton-platform-build/audit-safety.mdx";
import BenchmarkGatesPrompt from "../prompts/ableton-platform-build/benchmark-gates.mdx";
import CapabilityMatrixPrompt from "../prompts/ableton-platform-build/capability-matrix.mdx";
import DocumentationBuildPrompt from "../prompts/ableton-platform-build/documentation-build.mdx";
import DocumentationReviewPrompt from "../prompts/ableton-platform-build/documentation-review.mdx";
import DurabilityBranchPlanPrompt from "../prompts/ableton-platform-build/durability-branch-plan.mdx";
import ExhaustiveAuditPrompt from "../prompts/ableton-platform-build/exhaustive-audit.mdx";
import FinalArchitectureReviewPrompt from "../prompts/ableton-platform-build/final-architecture-review.mdx";
import FinalHandoffPrompt from "../prompts/ableton-platform-build/final-handoff.mdx";
import FinalReleaseReviewPrompt from "../prompts/ableton-platform-build/final-release-review.mdx";
import FinalReviewVerdictPrompt from "../prompts/ableton-platform-build/final-review-verdict.mdx";
import FinalUseCaseReviewPrompt from "../prompts/ableton-platform-build/final-use-case-review.mdx";
import ImplementAbletonPrompt from "../prompts/ableton-platform-build/implement-ableton.mdx";
import ImplementAnalysisPrompt from "../prompts/ableton-platform-build/implement-analysis.mdx";
import ImplementDeliveryPrompt from "../prompts/ableton-platform-build/implement-delivery.mdx";
import ImplementHostPrompt from "../prompts/ableton-platform-build/implement-host.mdx";
import ImplementationPlanPrompt from "../prompts/ableton-platform-build/implementation-plan.mdx";
import ImplementationRemediationPrompt from "../prompts/ableton-platform-build/implementation-remediation.mdx";
import ImplementationReviewPrompt from "../prompts/ableton-platform-build/implementation-review.mdx";
import IntegrateSlicePrompt from "../prompts/ableton-platform-build/integrate-slice.mdx";
import LiveComparePrompt from "../prompts/ableton-platform-build/live-compare.mdx";
import LiveExecutePrompt from "../prompts/ableton-platform-build/live-execute.mdx";
import LiveReadinessPrompt from "../prompts/ableton-platform-build/live-readiness.mdx";
import LiveRestorePrompt from "../prompts/ableton-platform-build/live-restore.mdx";
import LiveTestPlanPrompt from "../prompts/ableton-platform-build/live-test-plan.mdx";
import MatrixEvidenceUpdatePrompt from "../prompts/ableton-platform-build/matrix-evidence-update.mdx";
import PlatformDeliveryResearchPrompt from "../prompts/ableton-platform-build/platform-delivery-research.mdx";
import PreflightAssessPrompt from "../prompts/ableton-platform-build/preflight-assess.mdx";
import PriorArtResearchPrompt from "../prompts/ableton-platform-build/prior-art-research.mdx";
import PrClassifyPrompt from "../prompts/ableton-platform-build/pr-classify.mdx";
import PrRemediationPrompt from "../prompts/ableton-platform-build/pr-remediation.mdx";
import PrVerifyPrompt from "../prompts/ableton-platform-build/pr-verify.mdx";
import ProtocolSecurityResearchPrompt from "../prompts/ableton-platform-build/protocol-security-research.mdx";
import QualityGatesPrompt from "../prompts/ableton-platform-build/quality-gates.mdx";
import ResearchAbletonSdkPrompt from "../prompts/ableton-platform-build/research-ableton-sdk.mdx";
import ResearchPrBaselinePrompt from "../prompts/ableton-platform-build/research-pr-and-baseline.mdx";
import ResearchRepositoryPrompt from "../prompts/ableton-platform-build/research-repository.mdx";
import ResearchSecurityPackagingPrompt from "../prompts/ableton-platform-build/research-security-packaging.mdx";
import ResearchSynthesisPrompt from "../prompts/ableton-platform-build/research-synthesis.mdx";
import SafetyAudioResearchPrompt from "../prompts/ableton-platform-build/safety-audio-research.mdx";
import SliceSelectPrompt from "../prompts/ableton-platform-build/slice-select.mdx";
import TestStrategyPrompt from "../prompts/ableton-platform-build/test-strategy.mdx";
import UseCaseScanPrompt from "../prompts/ableton-platform-build/use-case-scan.mdx";
import ValidationAnalysisPrompt from "../prompts/ableton-platform-build/validation-analysis.mdx";
import ValidationFixPrompt from "../prompts/ableton-platform-build/validation-fix.mdx";
import VerifySlicePrompt from "../prompts/ableton-platform-build/verify-slice.mdx";
import LiveSafetyPlanPrompt from "../prompts/ableton-platform-build/live-safety-plan.mdx";

export const TARGET_BRANCH = "feat/comprehensive-ableton-mcp";
export const TARGET_PR = 1;
export const PROTECTED_SDK_PATH = "extensions-sdk-1.0.0-beta.0";

export const inputSchema = z.object({
  prompt: z.string().min(1).default("Build the comprehensive, production-grade Ableton MCP platform described by the repository requirements."),
  iterationBudget: z.number().int().min(1).max(50).default(8),
  liveTest: z.boolean().default(false),
});

const commandEvidenceSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

const evidenceSchema = z.object({
  source: z.string(),
  location: z.string().nullable().default(null),
  detail: z.string(),
  verified: z.boolean(),
});

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  area: z.string(),
  description: z.string(),
  evidence: z.array(z.string()).default([]),
  actionable: z.boolean().default(true),
});

const coverageSchema = z.object({
  lines: z.number().min(0).max(100).nullable().default(null),
  branches: z.number().min(0).max(100).nullable().default(null),
  functions: z.number().min(0).max(100).nullable().default(null),
  statements: z.number().min(0).max(100).nullable().default(null),
  measured: z.boolean().default(false),
});

const categorySchema = z.object({
  status: z.enum(["passed", "failed", "unavailable"]),
  commands: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  blocking: z.boolean().default(true),
});

const validationCategoriesSchema = z.object({
  unit: categorySchema,
  contract: categorySchema,
  property: categorySchema,
  integration: categorySchema,
  performance: categorySchema,
  e2e: categorySchema,
  security: categorySchema,
  ui: categorySchema,
  packaging: categorySchema,
});

const schemas = {
  preflightInspect: z.object({
    summary: z.string(),
    repositoryState: z.object({
      root: z.string(),
      branch: z.string(),
      headSha: z.string(),
      clean: z.boolean(),
      changedPaths: z.array(z.string()),
      protectedSdkIgnored: z.boolean(),
      protectedSdkTrackedPaths: z.array(z.string()),
    }),
    prState: z.object({
      number: z.number().int(),
      state: z.string(),
      headRefName: z.string(),
      headSha: z.string(),
      baseRefName: z.string(),
      url: z.string(),
      fetched: z.boolean(),
    }),
    configuredAgentPools: z.array(z.string()),
    budgetState: z.object({ iterationBudget: z.number().int(), liveTest: z.boolean() }),
    commands: z.array(commandEvidenceSchema),
    blockingIssues: z.array(z.string()),
    ready: z.boolean(),
  }),
  preflightAssess: z.object({
    summary: z.string(),
    approvedAssumptions: z.array(z.string()).default([]),
    boundaries: z.array(z.string()).default([]),
    recoveryRequired: z.boolean(),
    recoveryQuestion: z.string().nullable().default(null),
    ready: z.boolean(),
  }),
  recoveryState: z.object({
    summary: z.string(),
    decision: z.enum(["resume", "new-run", "stop"]),
    resumeAllowed: z.boolean(),
    requiresNewRun: z.boolean(),
    blockingReason: z.string().nullable().default(null),
  }),
  research: z.object({
    summary: z.string(),
    domain: z.enum(["repository", "ableton-sdk", "security-packaging", "pr-baseline", "prior-art", "protocol-security", "audio-safety", "platform-delivery"]),
    evidence: z.array(evidenceSchema).default([]),
    requirements: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    unknowns: z.array(z.string()).default([]),
    complete: z.boolean(),
  }),
  researchSynthesis: z.object({
    summary: z.string(),
    requirements: z.array(z.object({
      id: z.string(),
      statement: z.string(),
      sources: z.array(z.string()),
      acceptance: z.array(z.string()),
      blocking: z.boolean(),
    })).default([]),
    evidenceIndex: z.array(evidenceSchema).default([]),
    dependencies: z.array(z.string()).default([]),
    blockingUnknowns: z.array(z.string()).default([]),
    complete: z.boolean(),
  }),
  capabilityMatrix: z.object({
    summary: z.string(),
    capabilities: z.array(z.object({
      id: z.string(),
      capability: z.string(),
      support: z.enum(["implemented", "partial", "planned", "unsupported", "research-dependent"]),
      platforms: z.array(z.string()),
      implementationPaths: z.array(z.string()),
      evidence: z.array(z.string()),
      testObligations: z.array(z.string()),
      risks: z.array(z.string()),
    })).default([]),
    unsupported: z.array(z.string()).default([]),
    risky: z.array(z.string()).default([]),
    coverage: z.object({ total: z.number().int(), evidenced: z.number().int(), complete: z.boolean() }),
    approvalReady: z.boolean(),
  }),
  architecture: z.object({
    summary: z.string(),
    components: z.array(z.object({ name: z.string(), responsibility: z.string(), paths: z.array(z.string()), contracts: z.array(z.string()) })).default([]),
    decisions: z.array(z.string()).default([]),
    implementationBoundaries: z.array(z.string()).default([]),
    checkpointRules: z.array(z.string()).default([]),
    recoveryRules: z.array(z.string()).default([]),
    testObligations: z.array(z.string()).default([]),
    liveSafetyRules: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    approved: z.boolean(),
  }),
  specialistReview: z.object({
    summary: z.string(),
    reviewArea: z.string(),
    findings: z.array(findingSchema).default([]),
    criticalFindingIds: z.array(z.string()).default([]),
    remediationIds: z.array(z.string()).default([]),
    passed: z.boolean(),
  }),
  architectureApproval: z.object({
    approved: z.boolean(),
    note: z.string().nullable().default(null),
  }),
  planArtifact: z.object({
    summary: z.string(),
    artifact: z.string(),
    decisions: z.array(z.string()).default([]),
    actions: z.array(z.object({ id: z.string(), area: z.string(), description: z.string(), acceptanceChecks: z.array(z.string()) })).default([]),
    risks: z.array(z.string()).default([]),
    ready: z.boolean(),
  }),
  implementationWork: z.object({
    summary: z.string(),
    area: z.enum(["host", "ableton", "analysis", "delivery", "integration", "remediation", "pr-remediation", "audit-remediation"]),
    changedFiles: z.array(z.string()).default([]),
    requirementsAddressed: z.array(z.string()).default([]),
    commandsRun: z.array(commandEvidenceSchema).default([]),
    testsAddedOrUpdated: z.array(z.string()).default([]),
    sdkUntouched: z.boolean(),
    complete: z.boolean(),
    blockers: z.array(z.string()).default([]),
  }),
  validationScan: z.object({
    summary: z.string(),
    categories: validationCategoriesSchema,
    coverage: coverageSchema,
    issues: z.array(findingSchema).default([]),
    baselineFailures: z.array(z.string()).default([]),
    allRequiredPassed: z.boolean(),
  }),
  validationFix: z.object({
    summary: z.string(),
    addressedFailureIds: z.array(z.string()).default([]),
    changedFiles: z.array(z.string()).default([]),
    commandsRun: z.array(commandEvidenceSchema).default([]),
    remainingFailures: z.array(z.string()).default([]),
    complete: z.boolean(),
  }),
  benchmark: z.object({
    summary: z.string(),
    measurements: z.array(z.object({
      name: z.string(),
      value: z.number(),
      unit: z.string(),
      budget: z.number().nullable().default(null),
      passed: z.boolean(),
      command: z.string(),
    })).default([]),
    unavailable: z.array(z.string()).default([]),
    passed: z.boolean(),
  }),
  validationAnalysis: z.object({
    summary: z.string(),
    categories: validationCategoriesSchema,
    coverage: coverageSchema,
    blockingFailures: z.array(z.string()).default([]),
    baselineFailures: z.array(z.string()).default([]),
    remediationPlan: z.array(z.string()).default([]),
    passed: z.boolean(),
  }),
  documentation: z.object({
    summary: z.string(),
    documents: z.array(z.string()).default([]),
    requirementsCovered: z.array(z.string()).default([]),
    recoveryProcedures: z.array(z.string()).default([]),
    knownLimitations: z.array(z.string()).default([]),
    findings: z.array(findingSchema).default([]),
    complete: z.boolean(),
  }),
  liveTestPlan: z.object({
    summary: z.string(),
    planHash: z.string(),
    preconditions: z.array(z.string()),
    boundedActions: z.array(z.string()),
    compensationActions: z.array(z.string()),
    evidenceRequirements: z.array(z.string()),
    stopConditions: z.array(z.string()),
    safeToRequestApproval: z.boolean(),
  }),
  liveApproval: z.object({
    approved: z.boolean(),
    note: z.string().nullable().default(null),
  }),
  liveEvidence: z.object({
    summary: z.string(),
    stage: z.enum(["preflight", "action", "compensation", "cleanup", "review"]),
    planHash: z.string(),
    actions: z.array(z.string()).default([]),
    evidence: z.array(z.string()).default([]),
    safe: z.boolean(),
    passed: z.boolean(),
    compensationRequired: z.boolean(),
    stateRestored: z.boolean(),
    residualState: z.array(z.string()).default([]),
  }),
  checkpointState: z.object({
    summary: z.string(),
    commitSha: z.string(),
    createdCommit: z.boolean(),
    pushed: z.boolean(),
    branch: z.string(),
    changedPaths: z.array(z.string()),
    dirtyPaths: z.array(z.string()),
    sdkUntouched: z.boolean(),
    checkpointValid: z.boolean(),
    resumeToken: z.string(),
    commands: z.array(commandEvidenceSchema),
    errors: z.array(z.string()),
  }),
  prPoll: z.object({
    summary: z.string(),
    prNumber: z.number().int(),
    url: z.string(),
    headRefName: z.string(),
    headSha: z.string(),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    checks: z.array(z.record(z.string(), z.unknown())).default([]),
    reviews: z.array(z.record(z.string(), z.unknown())).default([]),
    comments: z.array(z.record(z.string(), z.unknown())).default([]),
    fetched: z.boolean(),
    errors: z.array(z.string()).default([]),
  }),
  prClassify: z.object({
    summary: z.string(),
    classifications: z.array(z.object({
      id: z.string(),
      kind: z.enum(["actionable", "resolved", "duplicate", "informational", "unsafe", "human-blocked"]),
      url: z.string().nullable().default(null),
      reason: z.string(),
    })).default([]),
    actionableIds: z.array(z.string()).default([]),
    requiredChecksSatisfied: z.boolean(),
    headMatchesCheckpoint: z.boolean(),
    requiresHuman: z.boolean(),
    acceptable: z.boolean(),
  }),
  audit: z.object({
    summary: z.string(),
    domain: z.enum(["requirements", "integrity", "safety", "exhaustive", "moderation"]),
    findings: z.array(findingSchema).default([]),
    criticalFindingIds: z.array(z.string()).default([]),
    remediationIds: z.array(z.string()).default([]),
    coverageComplete: z.boolean(),
    passed: z.boolean(),
  }),
  finalReview: z.object({
    summary: z.string(),
    findings: z.array(findingSchema).default([]),
    remediationIds: z.array(z.string()).default([]),
    unresolvedRisks: z.array(z.string()).default([]),
    humanQuestions: z.array(z.string()).default([]),
    recommendReady: z.boolean(),
  }),
  iterationDisposition: z.object({
    summary: z.string(),
    iterationNumber: z.number().int(),
    remaining: z.number().int(),
    ready: z.boolean(),
    repeat: z.boolean(),
    blocked: z.boolean(),
    unsafe: z.boolean(),
    budgetExhausted: z.boolean(),
    reasons: z.array(z.string()),
  }),
  readinessCandidate: z.object({
    summary: z.string(),
    validationPassed: z.boolean(),
    coverageMeasured: z.boolean(),
    checkpointValid: z.boolean(),
    checkpointPushed: z.boolean(),
    prAcceptable: z.boolean(),
    auditsPassed: z.boolean(),
    finalReviewPassed: z.boolean(),
    liveSafetyPassed: z.boolean(),
    autonomousChecksPass: z.boolean(),
    blockers: z.array(z.string()),
  }),
  finalReadinessApproval: z.object({
    approved: z.boolean(),
    note: z.string().nullable().default(null),
  }),
  output: z.object({
    summary: z.string(),
    status: z.enum(["ready", "not-ready", "blocked", "unsafe", "cancelled"]),
    phases: z.array(z.object({ phase: z.string(), status: z.string(), evidence: z.array(z.string()) })).default([]),
    checkpoints: z.array(z.string()).default([]),
    tests: z.record(z.string(), z.unknown()),
    coverage: coverageSchema,
    pr: z.record(z.string(), z.unknown()),
    approvals: z.array(z.record(z.string(), z.unknown())).default([]),
    risks: z.array(z.string()).default([]),
    resumability: z.record(z.string(), z.unknown()),
    liveSafety: z.record(z.string(), z.unknown()),
    evidence: z.array(evidenceSchema).default([]),
  }),
};

const {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Branch,
  Approval,
  Ralph,
  smithers,
  outputs,
} = createSmithers({ input: inputSchema, ...schemas });

type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
type PromptComponent = ComponentType<{ context?: unknown; schema?: unknown }>;

const WORKING_CONTRACT = [
  `Operate only in the existing ${TARGET_BRANCH} checkout, serially.`,
  "Do not create or switch worktrees or branches. Do not rebase, merge, release, publish, sign, or notarize. The deterministic checkpoint task may commit and push only the validated changes on the existing feature branch.",
  `Never modify, stage, copy from, or expose ${PROTECTED_SDK_PATH}; it is local, ignored, and read-only evidence.`,
  "Preserve unrelated changes. Do not edit this workflow, its UI, prompts, agent registry, or Smithers runtime state.",
  "Use real repository files and commands. Missing tools, credentials, devices, Live, signing identities, or platform runners are unavailable evidence, never passes.",
  "Implementation must be complete production code with real tests; TODO-only or static-success output is forbidden.",
].join("\n");

function guardedPrompt(Prompt: PromptComponent, context: unknown): ReactNode {
  const serializedContext = JSON.stringify(context, null, 2) ?? "null";
  const boundedContext = serializedContext.length > 80_000
    ? `${serializedContext.slice(0, 80_000)}\n... [context truncated at 80,000 characters]`
    : serializedContext;
  return (
    <>
      {WORKING_CONTRACT}
      {`\n\nCURRENT PERSISTED WORKFLOW CONTEXT (authoritative inputs and prior typed outputs):\n${boundedContext}\n\n`}
      <Prompt context={context} />
    </>
  );
}

function AiTask(props: {
  id: string;
  output: unknown;
  agent: AgentLike | AgentLike[] | readonly AgentLike[];
  Prompt: PromptComponent;
  context: unknown;
  retries?: number;
  timeoutMs?: number;
  skipIf?: boolean;
}) {
  return (
    <Task
      id={props.id}
      output={props.output as never}
      // Components such as Ralph/Saga require one concrete agent. The registry
      // stores fallback pools, so dispatch the primary configured provider here.
      agent={(Array.isArray(props.agent) ? props.agent[0] : props.agent) as AgentLike}
      retries={props.retries ?? 2}
      timeoutMs={props.timeoutMs ?? 60 * 60_000}
      heartbeatTimeoutMs={10 * 60_000}
      skipIf={props.skipIf}
    >
      {guardedPrompt(props.Prompt, props.context)}
    </Task>
  );
}

function runCommand(command: string, args: string[], cwd?: string): CommandEvidence {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: typeof result.status === "number" ? result.status : null,
    stdout: (result.stdout ?? "").trim().slice(-20_000),
    stderr: (result.stderr ?? result.error?.message ?? "").trim().slice(-20_000),
  };
}

function parseJsonRecord(command: CommandEvidence): Record<string, unknown> | undefined {
  if (command.exitCode !== 0 || !command.stdout) return undefined;
  try {
    const value: unknown = JSON.parse(command.stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringsFromStatus(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function inspectPreflight(iterationBudget: number, liveTest: boolean) {
  const rootCommand = runCommand("git", ["rev-parse", "--show-toplevel"]);
  const root = rootCommand.stdout || process.cwd();
  const branchCommand = runCommand("git", ["branch", "--show-current"], root);
  const headCommand = runCommand("git", ["rev-parse", "HEAD"], root);
  const statusCommand = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  const ignoredCommand = runCommand("git", ["check-ignore", "-q", PROTECTED_SDK_PATH], root);
  const trackedSdkCommand = runCommand("git", ["ls-files", "--", PROTECTED_SDK_PATH], root);
  const prCommand = runCommand("gh", [
    "pr", "view", String(TARGET_PR),
    "--json", "number,url,headRefName,headRefOid,baseRefName,state",
  ], root);
  const pr = parseJsonRecord(prCommand);
  const changedPaths = stringsFromStatus(statusCommand.stdout);
  const trackedSdkPaths = trackedSdkCommand.stdout.split(/\r?\n/).filter(Boolean);
  const prState = {
    number: Number(pr?.number ?? TARGET_PR),
    state: String(pr?.state ?? ""),
    headRefName: String(pr?.headRefName ?? ""),
    headSha: String(pr?.headRefOid ?? ""),
    baseRefName: String(pr?.baseRefName ?? ""),
    url: String(pr?.url ?? ""),
    fetched: Boolean(pr),
  };
  const blockingIssues: string[] = [];
  if (branchCommand.stdout !== TARGET_BRANCH) blockingIssues.push(`Expected branch ${TARGET_BRANCH}; found ${branchCommand.stdout || "(detached)"}.`);
  if (statusCommand.exitCode !== 0) blockingIssues.push("Could not inspect repository status.");
  if (changedPaths.length > 0) blockingIssues.push(`Checkout is dirty before the run: ${changedPaths.join(", ")}`);
  if (ignoredCommand.exitCode !== 0) blockingIssues.push(`${PROTECTED_SDK_PATH} is not ignored.`);
  if (trackedSdkPaths.length > 0) blockingIssues.push(`${PROTECTED_SDK_PATH} contains tracked paths.`);
  if (!prState.fetched) blockingIssues.push(`PR #${TARGET_PR} could not be fetched.`);
  if (prState.state !== "OPEN") blockingIssues.push(`PR #${TARGET_PR} is not open.`);
  if (prState.headRefName !== TARGET_BRANCH) blockingIssues.push(`PR #${TARGET_PR} does not target head branch ${TARGET_BRANCH}.`);
  return {
    summary: blockingIssues.length === 0
      ? `Preflight passed on ${TARGET_BRANCH} at ${headCommand.stdout}.`
      : `Preflight found ${blockingIssues.length} blocking issue(s).`,
    repositoryState: {
      root,
      branch: branchCommand.stdout,
      headSha: headCommand.stdout,
      clean: changedPaths.length === 0 && statusCommand.exitCode === 0,
      changedPaths,
      protectedSdkIgnored: ignoredCommand.exitCode === 0,
      protectedSdkTrackedPaths: trackedSdkPaths,
    },
    prState,
    configuredAgentPools: Object.keys(abletonAgents),
    budgetState: { iterationBudget, liveTest },
    commands: [rootCommand, branchCommand, headCommand, statusCommand, ignoredCommand, trackedSdkCommand, prCommand],
    blockingIssues,
    ready: blockingIssues.length === 0,
  };
}

function checkpointBranch(iterationNumber: number) {
  const commands: CommandEvidence[] = [];
  const errors: string[] = [];
  const rootCommand = runCommand("git", ["rev-parse", "--show-toplevel"]);
  commands.push(rootCommand);
  const root = rootCommand.stdout || process.cwd();
  const branchCommand = runCommand("git", ["branch", "--show-current"], root);
  commands.push(branchCommand);
  if (branchCommand.stdout !== TARGET_BRANCH) {
    errors.push(`Refusing to checkpoint branch ${branchCommand.stdout || "(detached)"}; expected ${TARGET_BRANCH}.`);
  }
  const trackedSdk = runCommand("git", ["ls-files", "--", PROTECTED_SDK_PATH], root);
  commands.push(trackedSdk);
  const sdkUntouched = trackedSdk.exitCode === 0 && trackedSdk.stdout === "";
  if (!sdkUntouched) errors.push(`Protected SDK path ${PROTECTED_SDK_PATH} contains tracked content.`);
  let changedPaths: string[] = [];
  let createdCommit = false;
  if (errors.length === 0) {
    // The SDK is root-ignored, so staging the repository will not include it.
    // Supplying an explicit pathspec for an ignored directory makes Git return
    // non-zero even though all eligible files were staged, which prevented
    // otherwise valid checkpoints from being committed.
    const add = runCommand("git", ["add", "-A", "--", "."], root);
    commands.push(add);
    if (add.exitCode !== 0) errors.push("Failed to stage the iteration changes.");
    const staged = runCommand("git", ["diff", "--cached", "--name-only"], root);
    commands.push(staged);
    changedPaths = staged.stdout.split(/\r?\n/).filter(Boolean);
    const protectedStaged = changedPaths.filter((path) => path === PROTECTED_SDK_PATH || path.startsWith(`${PROTECTED_SDK_PATH}/`));
    if (protectedStaged.length > 0) errors.push(`Protected SDK paths were staged: ${protectedStaged.join(", ")}`);
    const diffCheck = runCommand("git", ["diff", "--cached", "--check"], root);
    commands.push(diffCheck);
    if (diffCheck.exitCode !== 0) errors.push("git diff --cached --check failed.");
    if (errors.length === 0 && changedPaths.length > 0) {
      const commit = runCommand("git", ["commit", "-m", `chore: checkpoint Ableton platform build iteration ${iterationNumber}`], root);
      commands.push(commit);
      createdCommit = commit.exitCode === 0;
      if (!createdCommit) errors.push("Checkpoint commit failed.");
    }
  }
  const push = errors.length === 0
    ? runCommand("git", ["push", "origin", `HEAD:refs/heads/${TARGET_BRANCH}`], root)
    : { command: "git push (skipped)", exitCode: null, stdout: "", stderr: "Skipped because checkpoint validation failed." };
  commands.push(push);
  if (push.exitCode !== 0) errors.push("Checkpoint push failed.");
  const head = runCommand("git", ["rev-parse", "HEAD"], root);
  const status = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], root);
  commands.push(head, status);
  const dirtyPaths = stringsFromStatus(status.stdout);
  if (dirtyPaths.length > 0) errors.push(`Checkout remains dirty after checkpoint: ${dirtyPaths.join(", ")}`);
  const checkpointValid = errors.length === 0 && head.exitCode === 0 && push.exitCode === 0 && dirtyPaths.length === 0;
  return {
    summary: checkpointValid
      ? `Checkpoint ${head.stdout} is pushed to ${TARGET_BRANCH}.`
      : `Checkpoint failed with ${errors.length} error(s).`,
    commitSha: head.stdout,
    createdCommit,
    pushed: push.exitCode === 0,
    branch: branchCommand.stdout,
    changedPaths,
    dirtyPaths,
    sdkUntouched,
    checkpointValid,
    resumeToken: `${TARGET_BRANCH}:${head.stdout}:iteration-${iterationNumber}`,
    commands,
    errors,
  };
}

function pollPr() {
  const root = runCommand("git", ["rev-parse", "--show-toplevel"]).stdout || process.cwd();
  const command = runCommand("gh", [
    "pr", "view", String(TARGET_PR),
    "--json", "number,url,headRefName,headRefOid,reviewDecision,mergeStateStatus,statusCheckRollup,reviews,comments",
  ], root);
  const row = parseJsonRecord(command);
  const errors = row ? [] : [command.stderr || `Unable to fetch PR #${TARGET_PR}.`];
  return {
    summary: row ? `Fetched current PR #${TARGET_PR} state at ${String(row.headRefOid ?? "")}.` : `PR #${TARGET_PR} polling failed.`,
    prNumber: Number(row?.number ?? TARGET_PR),
    url: String(row?.url ?? ""),
    headRefName: String(row?.headRefName ?? ""),
    headSha: String(row?.headRefOid ?? ""),
    reviewDecision: String(row?.reviewDecision ?? ""),
    mergeStateStatus: String(row?.mergeStateStatus ?? ""),
    checks: Array.isArray(row?.statusCheckRollup) ? row.statusCheckRollup as Array<Record<string, unknown>> : [],
    reviews: Array.isArray(row?.reviews) ? row.reviews as Array<Record<string, unknown>> : [],
    comments: Array.isArray(row?.comments) ? row.comments as Array<Record<string, unknown>> : [],
    fetched: Boolean(row),
    errors,
  };
}

function dispositionFor(args: {
  loopIteration: number;
  budget: number;
  validation?: z.infer<typeof schemas.validationAnalysis>;
  documentation?: z.infer<typeof schemas.documentation>;
  live?: z.infer<typeof schemas.liveEvidence>;
  liveTest: boolean;
  checkpoint?: z.infer<typeof schemas.checkpointState>;
  pr?: z.infer<typeof schemas.prClassify>;
  audit?: z.infer<typeof schemas.audit>;
  review?: z.infer<typeof schemas.finalReview>;
}) {
  const reasons: string[] = [];
  if (args.validation?.passed !== true) reasons.push("Required validation categories are not all passing.");
  if (args.validation?.coverage.measured !== true) reasons.push("Coverage has not been measured.");
  if (args.documentation?.complete !== true) reasons.push("Documentation review is incomplete.");
  if (args.liveTest && !(args.live?.passed === true && args.live.stateRestored === true && args.live.safe === true)) {
    reasons.push("Approved Live testing lacks complete, safe, restored evidence.");
  }
  if (args.checkpoint?.checkpointValid !== true || args.checkpoint.pushed !== true) reasons.push("The iteration checkpoint is not valid and pushed.");
  if (args.pr?.acceptable !== true || args.pr.headMatchesCheckpoint !== true) reasons.push("PR #1 is not acceptable at the pushed checkpoint.");
  if (args.audit?.passed !== true || args.audit.coverageComplete !== true) reasons.push("Independent audits are not complete and passing.");
  if (args.review?.recommendReady !== true) reasons.push("Final review does not recommend readiness.");
  const unsafe = Boolean(args.live?.residualState.length) || args.live?.safe === false;
  if (unsafe) reasons.push("Live safety evidence reports residual or unsafe state.");
  const ready = reasons.length === 0 && !unsafe;
  const remaining = Math.max(0, args.budget - args.loopIteration - 1);
  const budgetExhausted = !ready && remaining === 0;
  return {
    summary: ready
      ? `Iteration ${args.loopIteration + 1} satisfied every autonomous readiness gate.`
      : `Iteration ${args.loopIteration + 1} requires ${budgetExhausted ? "human recovery" : "another bounded pass"}.`,
    iterationNumber: args.loopIteration + 1,
    remaining,
    ready,
    repeat: !ready && !unsafe && !budgetExhausted,
    blocked: budgetExhausted,
    unsafe,
    budgetExhausted,
    reasons,
  };
}

function readinessFor(args: {
  validation?: z.infer<typeof schemas.validationAnalysis>;
  checkpoint?: z.infer<typeof schemas.checkpointState>;
  pr?: z.infer<typeof schemas.prClassify>;
  audit?: z.infer<typeof schemas.audit>;
  review?: z.infer<typeof schemas.finalReview>;
  live?: z.infer<typeof schemas.liveEvidence>;
  liveTest: boolean;
}) {
  const blockers: string[] = [];
  const validationPassed = args.validation?.passed === true;
  const coverageMeasured = args.validation?.coverage.measured === true;
  const checkpointValid = args.checkpoint?.checkpointValid === true;
  const checkpointPushed = args.checkpoint?.pushed === true;
  const prAcceptable = args.pr?.acceptable === true && args.pr.headMatchesCheckpoint === true;
  const auditsPassed = args.audit?.passed === true && args.audit.coverageComplete === true;
  const finalReviewPassed = args.review?.recommendReady === true;
  const liveSafetyPassed = !args.liveTest || (args.live?.safe === true && args.live.passed === true && args.live.stateRestored === true && args.live.residualState.length === 0);
  if (!validationPassed) blockers.push("Validation is not passing.");
  if (!coverageMeasured) blockers.push("Coverage is not measured.");
  if (!checkpointValid || !checkpointPushed) blockers.push("Checkpoint is not valid and pushed.");
  if (!prAcceptable) blockers.push("PR #1 is not synchronized and acceptable.");
  if (!auditsPassed) blockers.push("Audits are not passing.");
  if (!finalReviewPassed) blockers.push("Final review is not passing.");
  if (!liveSafetyPassed) blockers.push("Live safety is not passing.");
  return {
    summary: blockers.length === 0 ? "Autonomous final-readiness evidence is complete." : `${blockers.length} final-readiness blocker(s) remain.`,
    validationPassed,
    coverageMeasured,
    checkpointValid,
    checkpointPushed,
    prAcceptable,
    auditsPassed,
    finalReviewPassed,
    liveSafetyPassed,
    autonomousChecksPass: blockers.length === 0,
    blockers,
  };
}

export default smithers((ctx) => {
  const budget = ctx.input.iterationBudget;
  const liveTest = ctx.input.liveTest;
  const preflight = ctx.outputMaybe(outputs.preflightInspect, { nodeId: "preflight-inspect" });
  const assessment = ctx.outputMaybe(outputs.preflightAssess, { nodeId: "preflight-assess" });
  const architectureApproval = ctx.outputMaybe(outputs.architectureApproval, { nodeId: "architecture-approval" });
  const disposition = ctx.latest(outputs.iterationDisposition, "iteration-disposition");
  const validationScan = ctx.latest(outputs.validationScan, "quality-gates");
  const validation = ctx.latest(outputs.validationAnalysis, "validation-analysis");
  const documentation = ctx.latest(outputs.documentation, "documentation-review");
  const livePlan = ctx.latest(outputs.liveTestPlan, "live-test-plan");
  const liveApproval = ctx.latest(outputs.liveApproval, "live-test-approval");
  const liveEvidence = ctx.latest(outputs.liveEvidence, "live-evidence-review");
  const checkpoint = ctx.latest(outputs.checkpointState, "checkpoint-state");
  const prPoll = ctx.latest(outputs.prPoll, "pr-poll");
  const prClassify = ctx.latest(outputs.prClassify, "pr-classify");
  const audit = ctx.latest(outputs.audit, "audit-moderation");
  const finalReview = ctx.latest(outputs.finalReview, "final-review-verdict");
  const readiness = ctx.outputMaybe(outputs.readinessCandidate, { nodeId: "readiness-candidate" });
  const loopIteration = ctx.iterations?.["delivery-loop"] ?? ctx.iteration ?? 0;
  const sharedContext = {
    goal: ctx.input.prompt,
    branch: TARGET_BRANCH,
    prNumber: TARGET_PR,
    liveTest,
    iterationBudget: budget,
    iteration: loopIteration,
    currentImplementationPlan: ctx.latest(outputs.planArtifact, "implementation-plan"),
    currentUseCaseScan: ctx.latest(outputs.planArtifact, "use-case-scan"),
    currentSlice: ctx.latest(outputs.planArtifact, "slice-select"),
    preflight,
    research: ctx.outputs.research,
    researchSynthesis: ctx.outputs.researchSynthesis,
    capabilityMatrix: ctx.outputs.capabilityMatrix,
    architecture: ctx.outputs.architecture,
    specialistReviews: ctx.outputs.specialistReview,
    plans: ctx.outputs.planArtifact,
    implementation: ctx.outputs.implementationWork,
    validation: ctx.outputs.validationAnalysis,
    documentation: ctx.outputs.documentation,
    checkpoints: ctx.outputs.checkpointState,
    pr: ctx.outputs.prPoll,
    prClassification: ctx.outputs.prClassify,
    audits: ctx.outputs.audit,
    finalReviews: ctx.outputs.finalReview,
  };

  return (
    <Workflow name="ableton-platform-build">
      <UI entry="../ui/ableton-platform-build.tsx" title="Ableton Platform Build" />
      <Sequence>
        <Task id="preflight-inspect" output={outputs.preflightInspect}>
          {() => inspectPreflight(budget, liveTest)}
        </Task>
        <AiTask
          id="preflight-assess"
          output={outputs.preflightAssess}
          agent={abletonAgents.planning}
          Prompt={PreflightAssessPrompt}
          context={{ goal: ctx.input.prompt, preflight }}
        />
        <Branch
          if={assessment?.ready === true && assessment.recoveryRequired === false}
          then={(
            <Sequence>
              <AiTask id="research-repository" output={outputs.research} agent={abletonAgents.research} Prompt={ResearchRepositoryPrompt} context={sharedContext} />
              <AiTask id="research-ableton-sdk" output={outputs.research} agent={abletonAgents.research} Prompt={ResearchAbletonSdkPrompt} context={sharedContext} />
              <AiTask id="research-security-packaging" output={outputs.research} agent={abletonAgents.research} Prompt={ResearchSecurityPackagingPrompt} context={sharedContext} />
              <AiTask id="research-pr-baseline" output={outputs.research} agent={abletonAgents.research} Prompt={ResearchPrBaselinePrompt} context={sharedContext} />
              <AiTask id="research-prior-art" output={outputs.research} agent={abletonAgents.research} Prompt={PriorArtResearchPrompt} context={sharedContext} />
              <AiTask id="research-protocol-security" output={outputs.research} agent={abletonAgents.research} Prompt={ProtocolSecurityResearchPrompt} context={sharedContext} />
              <AiTask id="research-audio-safety" output={outputs.research} agent={abletonAgents.research} Prompt={SafetyAudioResearchPrompt} context={sharedContext} />
              <AiTask id="research-platform-delivery" output={outputs.research} agent={abletonAgents.research} Prompt={PlatformDeliveryResearchPrompt} context={sharedContext} />
              <AiTask id="research-synthesis" output={outputs.researchSynthesis} agent={abletonAgents.planning} Prompt={ResearchSynthesisPrompt} context={sharedContext} />
              <AiTask id="capability-matrix" output={outputs.capabilityMatrix} agent={abletonAgents.planning} Prompt={CapabilityMatrixPrompt} context={sharedContext} />
              <AiTask id="architecture-design" output={outputs.architecture} agent={abletonAgents.planning} Prompt={ArchitectureDesignPrompt} context={sharedContext} />
              <AiTask id="test-strategy" output={outputs.architecture} agent={abletonAgents.validation} Prompt={TestStrategyPrompt} context={sharedContext} />
              <AiTask id="live-safety-plan" output={outputs.architecture} agent={abletonAgents.planning} Prompt={LiveSafetyPlanPrompt} context={sharedContext} />
              <AiTask id="durability-branch-plan" output={outputs.architecture} agent={abletonAgents.planning} Prompt={DurabilityBranchPlanPrompt} context={sharedContext} />
              <AiTask id="architecture-security-critique" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={ArchitectureSecurityCritiquePrompt} context={sharedContext} />
              <AiTask id="architecture-realtime-critique" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={ArchitectureRealtimeCritiquePrompt} context={sharedContext} />
              <AiTask id="architecture-platform-critique" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={ArchitecturePlatformCritiquePrompt} context={sharedContext} />
              <AiTask id="architecture-repair" output={outputs.architecture} agent={abletonAgents.implementation} Prompt={ArchitectureRepairPrompt} context={sharedContext} />
              <AiTask id="architecture-verdict" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={ArchitectureVerdictPrompt} context={sharedContext} />
              <Approval
                id="architecture-approval"
                output={outputs.architectureApproval}
                request={{
                  title: "Approve the Ableton platform architecture",
                  summary: "Approve only after reviewing the research, capability matrix, architecture, critiques, test strategy, Live safety plan, serial branch plan, and residual risks.",
                }}
                onDeny="continue"
              />
              <Branch
                if={architectureApproval?.approved === true}
                then={(
                  <Sequence>
                    <Ralph
                      id="delivery-loop"
                      until={disposition?.ready === true || disposition?.blocked === true || disposition?.unsafe === true}
                      maxIterations={budget}
                      onMaxReached="return-last"
                      continueAsNewEvery={4}
                    >
                      <Sequence>
                        <AiTask id="implementation-plan" output={outputs.planArtifact} agent={abletonAgents.planning} Prompt={ImplementationPlanPrompt} context={sharedContext} />
                        <AiTask id="use-case-scan" output={outputs.planArtifact} agent={abletonAgents.planning} Prompt={UseCaseScanPrompt} context={sharedContext} />
                        <AiTask id="slice-select" output={outputs.planArtifact} agent={abletonAgents.planning} Prompt={SliceSelectPrompt} context={sharedContext} />
                        <AiTask id="implement-host" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={ImplementHostPrompt} context={sharedContext} />
                        <AiTask id="implement-ableton" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={ImplementAbletonPrompt} context={sharedContext} />
                        <AiTask id="implement-analysis" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={ImplementAnalysisPrompt} context={sharedContext} />
                        <AiTask id="implement-delivery" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={ImplementDeliveryPrompt} context={sharedContext} />
                        <AiTask id="integrate-slice" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={IntegrateSlicePrompt} context={sharedContext} />
                        <AiTask id="implementation-review" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={ImplementationReviewPrompt} context={sharedContext} />
                        <Branch
                          if={ctx.latest(outputs.specialistReview, "implementation-review")?.remediationIds.length ? true : false}
                          then={<AiTask id="implementation-remediation" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={ImplementationRemediationPrompt} context={sharedContext} />}
                          else={null}
                        />
                        <AiTask id="quality-gates" output={outputs.validationScan} agent={abletonAgents.validation} Prompt={QualityGatesPrompt} context={sharedContext} />
                        <Branch
                          if={validationScan?.allRequiredPassed === false}
                          then={<AiTask id="validation-fix" output={outputs.validationFix} agent={abletonAgents.implementation} Prompt={ValidationFixPrompt} context={sharedContext} />}
                          else={null}
                        />
                        <AiTask id="validation-verify" output={outputs.validationScan} agent={abletonAgents.validation} Prompt={VerifySlicePrompt} context={sharedContext} />
                        <AiTask id="benchmark-gates" output={outputs.benchmark} agent={abletonAgents.validation} Prompt={BenchmarkGatesPrompt} context={sharedContext} />
                        <AiTask id="validation-analysis" output={outputs.validationAnalysis} agent={abletonAgents.validation} Prompt={ValidationAnalysisPrompt} context={sharedContext} />
                        <AiTask id="documentation-build" output={outputs.documentation} agent={abletonAgents.implementation} Prompt={DocumentationBuildPrompt} context={sharedContext} />
                        <AiTask id="documentation-review" output={outputs.documentation} agent={abletonAgents.review} Prompt={DocumentationReviewPrompt} context={sharedContext} />
                        <AiTask id="matrix-evidence-update" output={outputs.capabilityMatrix} agent={abletonAgents.validation} Prompt={MatrixEvidenceUpdatePrompt} context={sharedContext} />
                        <Branch
                          if={liveTest && validation?.passed === true}
                          then={(
                            <Sequence>
                              <AiTask id="live-test-plan" output={outputs.liveTestPlan} agent={abletonAgents.planning} Prompt={LiveTestPlanPrompt} context={sharedContext} />
                              <Approval
                                id="live-test-approval"
                                output={outputs.liveApproval}
                                request={{
                                  title: "Approve the exact bounded Ableton Live test",
                                  summary: `Approve only the persisted plan hash ${livePlan?.planHash ?? "(pending)"} with its preconditions, bounded actions, stop conditions, evidence, cleanup, and compensation.`,
                                }}
                                onDeny="continue"
                              />
                              <Branch
                                if={liveApproval?.approved === true && livePlan?.safeToRequestApproval === true}
                                then={(
                                  <Sequence>
                                    <Saga
                                      id="guarded-live-test"
                                      onFailure="compensate-and-fail"
                                      steps={[{
                                        id: "approved-live-action",
                                        action: (
                                          <Sequence>
                                            <AiTask id="live-preflight" output={outputs.liveEvidence} agent={abletonAgents.validation} Prompt={LiveReadinessPrompt} context={{ ...sharedContext, livePlan }} />
                                            <AiTask id="live-action" output={outputs.liveEvidence} agent={abletonAgents.implementation} Prompt={LiveExecutePrompt} context={{ ...sharedContext, livePlan }} />
                                          </Sequence>
                                        ),
                                        compensation: (
                                          <AiTask id="live-compensate" output={outputs.liveEvidence} agent={abletonAgents.implementation} Prompt={LiveRestorePrompt} context={{ ...sharedContext, livePlan }} />
                                        ),
                                      }]}
                                    />
                                    <AiTask id="live-cleanup" output={outputs.liveEvidence} agent={abletonAgents.implementation} Prompt={LiveRestorePrompt} context={{ ...sharedContext, livePlan }} />
                                    <AiTask id="live-evidence-review" output={outputs.liveEvidence} agent={abletonAgents.review} Prompt={LiveComparePrompt} context={{ ...sharedContext, livePlan }} />
                                  </Sequence>
                                )}
                                else={(
                                  <Task id="live-test-not-approved" output={outputs.recoveryState}>
                                    {() => ({
                                      summary: "Live testing was not approved or its plan was not safe to approve; no Live action ran.",
                                      decision: "resume" as const,
                                      resumeAllowed: true,
                                      requiresNewRun: false,
                                      blockingReason: "Live test approval was denied or unsafe.",
                                    })}
                                  </Task>
                                )}
                              />
                            </Sequence>
                          )}
                          else={null}
                        />
                        <Task id="checkpoint-state" output={outputs.checkpointState}>
                          {() => checkpointBranch(loopIteration + 1)}
                        </Task>
                        <Task id="pr-poll" output={outputs.prPoll}>
                          {pollPr}
                        </Task>
                        <AiTask id="pr-classify" output={outputs.prClassify} agent={abletonAgents.validation} Prompt={PrClassifyPrompt} context={{ ...sharedContext, checkpoint, prPoll }} />
                        <Branch
                          if={Boolean(prClassify?.actionableIds.length)}
                          then={<AiTask id="pr-remediation" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={PrRemediationPrompt} context={{ ...sharedContext, prPoll, prClassify }} />}
                          else={null}
                        />
                        <AiTask id="pr-verify" output={outputs.prClassify} agent={abletonAgents.review} Prompt={PrVerifyPrompt} context={{ ...sharedContext, checkpoint, prPoll, prClassify }} />
                        <Parallel maxConcurrency={4}>
                          <AiTask id="audit-requirements" output={outputs.audit} agent={abletonAgents.review} Prompt={AuditRequirementsPrompt} context={sharedContext} />
                          <AiTask id="audit-integrity" output={outputs.audit} agent={abletonAgents.review} Prompt={AuditIntegrityPrompt} context={sharedContext} />
                          <AiTask id="audit-safety" output={outputs.audit} agent={abletonAgents.review} Prompt={AuditSafetyPrompt} context={sharedContext} />
                          <AiTask id="audit-exhaustive" output={outputs.audit} agent={abletonAgents.review} Prompt={ExhaustiveAuditPrompt} context={sharedContext} />
                        </Parallel>
                        <AiTask id="audit-moderation" output={outputs.audit} agent={abletonAgents.planning} Prompt={AuditModerationPrompt} context={sharedContext} />
                        <Branch
                          if={Boolean(audit?.remediationIds.length)}
                          then={<AiTask id="audit-remediation" output={outputs.implementationWork} agent={abletonAgents.implementation} Prompt={AuditRemediationPrompt} context={sharedContext} />}
                          else={null}
                        />
                        <Parallel maxConcurrency={3}>
                          <AiTask id="final-architecture-review" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={FinalArchitectureReviewPrompt} context={sharedContext} />
                          <AiTask id="final-use-case-review" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={FinalUseCaseReviewPrompt} context={sharedContext} />
                          <AiTask id="final-release-review" output={outputs.specialistReview} agent={abletonAgents.review} Prompt={FinalReleaseReviewPrompt} context={sharedContext} />
                        </Parallel>
                        <AiTask id="final-review-verdict" output={outputs.finalReview} agent={abletonAgents.planning} Prompt={FinalReviewVerdictPrompt} context={sharedContext} />
                        <Task id="iteration-disposition" output={outputs.iterationDisposition}>
                          {() => dispositionFor({
                            loopIteration,
                            budget,
                            validation,
                            documentation,
                            live: liveEvidence,
                            liveTest,
                            checkpoint,
                            pr: ctx.latest(outputs.prClassify, "pr-verify"),
                            audit,
                            review: finalReview,
                          })}
                        </Task>
                      </Sequence>
                    </Ralph>
                    <Task id="final-pr-refresh" output={outputs.prPoll}>
                      {pollPr}
                    </Task>
                    <Task id="readiness-candidate" output={outputs.readinessCandidate}>
                      {() => readinessFor({
                        validation,
                        checkpoint,
                        pr: ctx.latest(outputs.prClassify, "pr-verify"),
                        audit,
                        review: finalReview,
                        live: liveEvidence,
                        liveTest,
                      })}
                    </Task>
                    <Approval
                      id="final-readiness-approval"
                      output={outputs.finalReadinessApproval}
                      request={{
                        title: "Approve final Ableton platform readiness",
                        summary: "Approve only when validation, measured coverage, pushed checkpoints, PR #1, audits, Live safety, recovery, and final reviews all match the current head SHA.",
                      }}
                      skipIf={readiness?.autonomousChecksPass !== true}
                      onDeny="continue"
                    />
                    <Branch
                      if={readiness?.autonomousChecksPass === false}
                      then={(
                        <HumanTask
                          id="exceptional-recovery"
                          output={outputs.recoveryState}
                          prompt="Autonomous readiness failed. Return JSON choosing resume, new-run, or stop, with resumeAllowed, requiresNewRun, blockingReason, and summary."
                        />
                      )}
                      else={null}
                    />
                  </Sequence>
                )}
                else={(
                  <Task id="architecture-denied" output={outputs.recoveryState}>
                    {() => ({
                      summary: "Architecture approval was denied; implementation did not run.",
                      decision: "stop" as const,
                      resumeAllowed: false,
                      requiresNewRun: true,
                      blockingReason: "Architecture approval denied.",
                    })}
                  </Task>
                )}
              />
            </Sequence>
          )}
          else={(
            <HumanTask
              id="preflight-recovery"
              output={outputs.recoveryState}
              prompt="Preflight is blocked. Return JSON choosing resume, new-run, or stop, with resumeAllowed, requiresNewRun, blockingReason, and summary."
              skipIf={!assessment}
            />
          )}
        />
        <AiTask
          id="final-report"
          output={outputs.output}
          agent={abletonAgents.planning}
          Prompt={FinalHandoffPrompt}
          context={{
            ...sharedContext,
            disposition,
            readiness,
            finalApproval: ctx.outputMaybe(outputs.finalReadinessApproval, { nodeId: "final-readiness-approval" }),
            recovery: ctx.outputs.recoveryState,
          }}
        />
      </Sequence>
    </Workflow>
  );
}, { output: outputs.output });
