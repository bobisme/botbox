import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DESIGN_DOCS_DIR = join(__dirname, "..", "..", "docs", "design")
const VERSION_FILE = ".design-docs-version"

/**
 * @typedef {object} DesignDocEntry
 * @property {string} description
 * @property {string[]} projectTypes - Project types this doc applies to
 */

/** @type {Record<string, DesignDocEntry>} */
const DESIGN_DOC_REGISTRY = {
  "cli-conventions.md": {
    description: "CLI tool design conventions for humans, agents, and machines",
    projectTypes: ["cli", "tui"],
  },
  // Future docs:
  // "api-conventions.md": {
  //   description: "API design conventions",
  //   projectTypes: ["api"],
  // },
  // "library-conventions.md": {
  //   description: "Library design conventions",
  //   projectTypes: ["library"],
  // },
}

/** @returns {string[]} List of .md filenames in the bundled design docs dir */
export function listAllDesignDocs() {
  if (!existsSync(DESIGN_DOCS_DIR)) {
    return []
  }
  return readdirSync(DESIGN_DOCS_DIR).filter((f) => f.endsWith(".md"))
}

/**
 * Return design docs eligible for the given project type.
 * @param {string} projectType
 * @returns {string[]}
 */
export function listEligibleDesignDocs(projectType) {
  return listAllDesignDocs().filter((name) => {
    let entry = DESIGN_DOC_REGISTRY[name]
    return entry ? entry.projectTypes.includes(projectType) : false
  })
}

/**
 * Copy eligible design docs to a target directory.
 * @param {string} targetDir
 * @param {string} projectType
 * @returns {string[]} List of copied doc filenames
 */
export function copyDesignDocs(targetDir, projectType) {
  let eligible = listEligibleDesignDocs(projectType)
  if (eligible.length === 0) {
    return []
  }

  mkdirSync(targetDir, { recursive: true })
  for (let file of eligible) {
    let dest = join(targetDir, file)
    copyFileSync(join(DESIGN_DOCS_DIR, file), dest)
  }
  return eligible
}

/**
 * Sync design docs: update existing AND add new eligible docs.
 * @param {string} targetDir
 * @param {string} projectType
 * @returns {{ updated: string[], added: string[] }}
 */
export function syncDesignDocs(targetDir, projectType) {
  let updated = []
  let added = []
  let eligible = listEligibleDesignDocs(projectType)

  // Ensure directory exists if we have eligible docs
  if (eligible.length > 0 && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  for (let file of eligible) {
    let dest = join(targetDir, file)
    let existed = existsSync(dest)
    copyFileSync(join(DESIGN_DOCS_DIR, file), dest)
    if (existed) {
      updated.push(file)
    } else {
      added.push(file)
    }
  }

  return { updated, added }
}

/**
 * Compute a version hash from all bundled design docs.
 * @returns {string}
 */
export function currentDesignDocsVersion() {
  let docs = listAllDesignDocs()
  if (docs.length === 0) {
    return "000000000000"
  }
  let hash = createHash("sha256")
  for (let file of docs.sort()) {
    hash.update(readFileSync(join(DESIGN_DOCS_DIR, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Write a design docs version marker to the target directory.
 * @param {string} targetDir
 */
export function writeDesignDocsVersionMarker(targetDir) {
  writeFileSync(join(targetDir, VERSION_FILE), currentDesignDocsVersion())
}

/**
 * Read the installed design docs version marker.
 * @param {string} targetDir
 * @returns {string | null}
 */
export function readDesignDocsVersionMarker(targetDir) {
  try {
    return readFileSync(join(targetDir, VERSION_FILE), "utf-8").trim()
  } catch {
    return null
  }
}
