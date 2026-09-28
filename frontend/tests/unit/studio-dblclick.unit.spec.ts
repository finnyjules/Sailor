// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { isStudioControl } from '~/lib/canvas/studioDblclick'

function eventOn(el: HTMLElement): MouseEvent {
  return { target: el } as unknown as MouseEvent
}

describe('isStudioControl', () => {
  it('is true for a click inside a button', () => {
    const button = document.createElement('button')
    const inner = document.createElement('span')
    button.appendChild(inner)
    document.body.appendChild(button)
    expect(isStudioControl(eventOn(inner))).toBe(true)
  })
  it('is true for a click inside an input, textarea or select', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const el = document.createElement(tag)
      expect(isStudioControl(eventOn(el))).toBe(true)
    }
  })
  it('is false for a click on a plain div', () => {
    const div = document.createElement('div')
    expect(isStudioControl(eventOn(div))).toBe(false)
  })
})
