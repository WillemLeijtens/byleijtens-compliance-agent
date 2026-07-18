/** Opent (of update) een GitHub Issue met de compliance-bevindingen.
 *  Gebruikt de automatische GITHUB_TOKEN uit Actions — geen los secret nodig. */
async function openComplianceIssue({ token, repo, markdownBody, violationCount, dateStr }) {
  if (!token || !repo) {
    console.warn("  ⚠ Geen GITHUB_TOKEN/GITHUB_REPOSITORY beschikbaar — issue wordt overgeslagen (normaal buiten GitHub Actions).");
    return null;
  }
  const [owner, name] = repo.split("/");
  const title = `⚠️ Compliance-scan ${dateStr}: ${violationCount} product(en) met verboden/beperkte ingrediënten`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body: markdownBody, labels: ["compliance", "automated"] }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub issue aanmaken mislukt (${res.status}): ${text}`);
  }
  const issue = await res.json();
  console.log(`  ✓ GitHub issue aangemaakt: ${issue.html_url}`);
  return issue;
}

module.exports = { openComplianceIssue };
