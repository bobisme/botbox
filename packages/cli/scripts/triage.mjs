#!/usr/bin/env bun
/**
 * triage.mjs - Token-efficient bead triage output
 *
 * Wraps `bv --robot-triage` and extracts just the essential information
 * in a clean, readable format that doesn't waste tokens on verbose JSON.
 *
 * Usage: bun .agents/botbox/scripts/triage.mjs
 */

import { execSync } from "node:child_process"

try {
  // Run bv --robot-triage and capture output
  let output = execSync("bv --robot-triage", {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  })

  let data = JSON.parse(output)
  let triage = data.triage

  // Extract quick ref
  let qr = triage.quick_ref
  console.log(`📊 Triage Summary`)
  console.log(`   Open: ${qr.open_count} | Actionable: ${qr.actionable_count} | Blocked: ${qr.blocked_count} | In Progress: ${qr.in_progress_count}`)
  console.log()

  // Top picks
  if (qr.top_picks && qr.top_picks.length > 0) {
    console.log(`🎯 Top Picks`)
    for (let pick of qr.top_picks.slice(0, 5)) {
      let score = (pick.score * 100).toFixed(1)
      let unblocks = pick.unblocks > 0 ? ` (unblocks ${pick.unblocks})` : ""
      console.log(`   ${pick.id}: ${pick.title}`)
      console.log(`      Score: ${score}%${unblocks}`)
    }
    console.log()
  }

  // Blockers to clear (if any)
  if (triage.blockers_to_clear && triage.blockers_to_clear.length > 0) {
    console.log(`🚧 Blockers to Clear`)
    for (let blocker of triage.blockers_to_clear.slice(0, 5)) {
      console.log(`   ${blocker.id}: ${blocker.title} (blocks ${blocker.blocks_count})`)
    }
    console.log()
  }

  // Quick wins
  if (triage.quick_wins && triage.quick_wins.length > 0) {
    console.log(`⚡ Quick Wins`)
    for (let win of triage.quick_wins.slice(0, 3)) {
      console.log(`   ${win.id}: ${win.title}`)
    }
    console.log()
  }

  // Recommendations with minimal detail
  if (triage.recommendations && triage.recommendations.length > 0) {
    console.log(`📋 Recommendations`)
    for (let rec of triage.recommendations.slice(0, 6)) {
      let labels = rec.labels ? ` [${rec.labels.join(", ")}]` : ""
      let priority = `P${rec.priority}`
      console.log(`   ${rec.id} (${priority}${labels}): ${rec.title}`)
      if (rec.reasons && rec.reasons.length > 0) {
        console.log(`      → ${rec.reasons[0]}`)
      }
    }
    console.log()
  }

  // Health summary
  let health = triage.project_health
  if (health) {
    console.log(`📈 Project Health`)
    console.log(`   Total: ${health.counts.total} | Closed: ${health.counts.closed} | Open: ${health.counts.open}`)
    if (health.velocity) {
      let v = health.velocity
      console.log(`   Velocity: ${v.closed_last_7_days} closed/week | Avg ${v.avg_days_to_close.toFixed(1)} days to close`)
    }
  }

  // Command hint
  console.log()
  console.log(`💡 Claim top: br update --actor $AGENT ${qr.top_picks[0]?.id} --status in_progress`)

} catch (err) {
  if (err.stderr) {
    console.error(`Error running bv: ${err.stderr.toString()}`)
  } else if (err.message) {
    console.error(`Error: ${err.message}`)
  }
  process.exit(1)
}
