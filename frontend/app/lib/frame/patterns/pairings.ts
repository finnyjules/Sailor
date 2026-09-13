// A small standalone face-pairing table (folds into the sub-project-2 shelf's
// per-family `pairings` field later). Given a TITLE family, suggest a TEXT face
// that reads well beside it at caption size, with a one-line reason. The layout
// sheet never rolls a face — this only fires when the user presses Suggest.

interface Pairing { family: string; reason: string }

const PAIRINGS: Record<string, Pairing> = {
  'Big Shoulders Display': { family: 'Inter', reason: 'A tall, tightly-spaced display cut — Inter reads cleanly beside it at small sizes.' },
  'Unbounded': { family: 'Space Grotesk', reason: 'A rounded display face — Space Grotesk keeps a geometric feel without the weight.' },
  'Bricolage Grotesque': { family: 'Inter', reason: 'An expressive grotesque headline — Inter is the neutral text face that lets it lead.' },
  'Fraunces': { family: 'Inter', reason: 'A high-contrast display serif — a clean sans like Inter balances it in the details.' },
  'Archivo': { family: 'Source Serif 4', reason: 'A sturdy grotesque headline gains contrast from a serif text face.' },
  'Space Grotesk': { family: 'Inter', reason: 'A geometric headline sans — Inter is the quieter neighbour for running text.' },
  'Inter': { family: 'Source Serif 4', reason: 'A neutral sans headline gains warmth from a serif in the details.' },
  'Roboto Flex': { family: 'Source Serif 4', reason: 'A workhorse sans headline pairs with a serif text face for contrast.' },
  'Recursive': { family: 'Inter', reason: 'A characterful variable headline — Inter keeps the small print calm.' },
  'Source Serif 4': { family: 'Inter', reason: 'A serif headline reads best with a clean sans in the small print.' },
}

const DEFAULT: Pairing = { family: 'Inter', reason: 'Inter is a neutral, highly legible text face beside most display headlines.' }

export function suggestTextFace(titleFamily: string): Pairing {
  return PAIRINGS[titleFamily] ?? DEFAULT
}
