import { hmacSha256Hex, timingSafeEqual } from "./utils.js";
import {
  createIncident,
  createMaintenance,
  findIncidentByPR,
  findMaintenanceByPR,
  addIncidentUpdate,
  addMaintenanceUpdate,
  resolveIncident,
  completeMaintenance,
} from "./status.js";

const INCIDENT_LABEL = "incident";
const MAINTENANCE_LABEL = "maintenance";

export async function verifySignature(request, rawBody, secret) {
  const header = request.headers.get("x-hub-signature-256") || "";
  if (!secret) return true; // no secret configured -> skip (dev mode)
  if (!header.startsWith("sha256=")) return false;
  const expected = "sha256=" + (await hmacSha256Hex(secret, rawBody));
  return timingSafeEqual(header, expected);
}

function hasLabel(pr, name) {
  return (pr.labels || []).some((l) => l.name?.toLowerCase() === name);
}

// Very small heuristic to bump an incident's status based on comment text,
// e.g. a PR comment saying "identified the root cause" -> status: identified.
function statusFromComment(text) {
  const t = text.toLowerCase();
  if (/\bresolved\b|\bfixed\b|\ball clear\b/.test(t)) return "resolved";
  if (/\bmonitoring\b/.test(t)) return "monitoring";
  if (/\bidentified\b|\broot cause\b/.test(t)) return "identified";
  return "investigating";
}

function maintenanceStatusFromComment(text) {
  const t = text.toLowerCase();
  if (/\bcomplete\b|\bcompleted\b|\bdone\b/.test(t)) return "completed";
  if (/\bstarting\b|\bin progress\b|\bstarted\b/.test(t)) return "in_progress";
  if (/\bcancel\b/.test(t)) return "cancelled";
  return "scheduled";
}

export async function handleGithubEvent(env, eventName, payload) {
  switch (eventName) {
    case "pull_request":
      return handlePullRequest(env, payload);
    case "issue_comment":
      return handleIssueComment(env, payload);
    default:
      return { ignored: true, event: eventName };
  }
}

async function handlePullRequest(env, payload) {
  const { action, pull_request: pr, repository } = payload;
  if (!pr || !repository) return { ignored: true };
  const repo = repository.full_name;
  const prNumber = pr.number;
  const prUrl = pr.html_url;
  const author = pr.user?.login;

  if (action === "opened" || action === "reopened" || action === "labeled") {
    const isIncident = hasLabel(pr, INCIDENT_LABEL);
    const isMaintenance = hasLabel(pr, MAINTENANCE_LABEL);

    if (isIncident) {
      const existing = await findIncidentByPR(env, repo, prNumber);
      if (!existing) {
        const id = await createIncident(env, {
          title: pr.title,
          body: pr.body || "",
          impact: "major",
          source: "github",
          repo,
          prNumber,
          prUrl,
          author,
        });
        return { created: "incident", id };
      }
    }

    if (isMaintenance) {
      const existing = await findMaintenanceByPR(env, repo, prNumber);
      if (!existing) {
        const id = await createMaintenance(env, {
          title: pr.title,
          body: pr.body || "",
          source: "github",
          repo,
          prNumber,
          prUrl,
          author,
          scheduledStart: new Date().toISOString(),
          scheduledEnd: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        });
        return { created: "maintenance", id };
      }
    }
  }

  if (action === "closed") {
    const wasMerged = !!pr.merged;
    const closingMsg = wasMerged
      ? `PR #${prNumber} was merged — closing out.`
      : `PR #${prNumber} was closed without merging — closing out.`;

    const incident = await findIncidentByPR(env, repo, prNumber);
    if (incident && incident.status !== "resolved") {
      await resolveIncident(env, incident.id, closingMsg, author, "github");
      return { resolved: "incident", id: incident.id };
    }

    const maintenance = await findMaintenanceByPR(env, repo, prNumber);
    if (maintenance && maintenance.status !== "completed" && maintenance.status !== "cancelled") {
      await completeMaintenance(
        env,
        maintenance.id,
        wasMerged ? closingMsg : "Maintenance cancelled — PR closed without merging.",
        author,
        "github"
      );
      return { completed: "maintenance", id: maintenance.id };
    }
  }

  return { ignored: true };
}

async function handleIssueComment(env, payload) {
  const { action, issue, comment, repository } = payload;
  if (action !== "created" || !issue?.pull_request) return { ignored: true };
  const repo = repository.full_name;
  const prNumber = issue.number;
  const author = comment.user?.login;
  const text = comment.body || "";

  const incident = await findIncidentByPR(env, repo, prNumber);
  if (incident && incident.status !== "resolved") {
    const status = statusFromComment(text);
    await addIncidentUpdate(env, incident.id, { status, message: text, author, source: "github" });
    return { updated: "incident", id: incident.id, status };
  }

  const maintenance = await findMaintenanceByPR(env, repo, prNumber);
  if (maintenance && maintenance.status !== "completed" && maintenance.status !== "cancelled") {
    const status = maintenanceStatusFromComment(text);
    await addMaintenanceUpdate(env, maintenance.id, { status, message: text, author, source: "github" });
    return { updated: "maintenance", id: maintenance.id, status };
  }

  return { ignored: true };
}
