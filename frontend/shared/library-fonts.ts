/** One selectable font file (a single weight/italic of a family). */
export interface LibraryFace {
  /** Stable id: `${foundry}-${slug(postscriptName)}`. Manifest key + route key. */
  id: string
  /** OS/2 usWeightClass (100–900; Pangram uses non-standard values like Book=375). */
  weight: number
  /** Human style label from preferredSubfamily, e.g. "Book", "Heavy Italic". */
  style: string
  italic: boolean
  postscriptName: string
  /** Path relative to `fontsRoot`. Resolved server-side; never sent to the client raw. */
  src: string
}

export interface LibraryFamily {
  /** `${foundry}-${slug(family)}`. */
  id: string
  /** Typographic family name, e.g. "PP Editorial New". */
  family: string
  /** Foundry id: "pangram" | "off-type". */
  foundry: string
  faces: LibraryFace[]
}

export interface LibraryFoundry { id: string; label: string }

export interface LibraryManifest {
  generatedAt: string
  /** Bundle root relative to the repo root, e.g. "Assets/Fonts". */
  fontsRoot: string
  foundries: LibraryFoundry[]
  families: LibraryFamily[]
}
