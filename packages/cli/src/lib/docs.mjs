import { createHash } from "node:crypto"
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = join(__dirname, "..", "..", "docs")
const VERSION_FILE = ".version"

/** @returns {string[]} List of workflow doc filenames */
export function listWorkflowDocs() {
  return readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))
}

/**
 * Copy bundled workflow docs to a target directory.
 * @param {string} targetDir
 */
export function copyWorkflowDocs(targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const file of listWorkflowDocs()) {
    copyFileSync(join(DOCS_DIR, file), join(targetDir, file))
  }
}

/**
 * Compute a version hash from the bundled docs.
 * @returns {string}
 */
export function currentVersion() {
  const hash = createHash("sha256")
  for (const file of listWorkflowDocs().sort()) {
    hash.update(readFileSync(join(DOCS_DIR, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Write a version marker to the target directory.
 * @param {string} targetDir
 */
export function writeVersionMarker(targetDir) {
  writeFileSync(join(targetDir, VERSION_FILE), currentVersion())
}

/**
 * Read the installed version marker.
 * @param {string} targetDir
 * @returns {string | null}
 */
export function readVersionMarker(targetDir) {
  try {
    return readFileSync(join(targetDir, VERSION_FILE), "utf-8").trim()
  } catch {
    return null
  }
}
