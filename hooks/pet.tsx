// The shiba, animated on the surface's own frame clock (as Flightdeck's rail.tsx draws its packets):
// only this region redraws, the pane does not. With `motion` off it rests on its first frame.
import type { ClientModule } from 'claude-code'

import { CAT_FRAMES, FRAMES, FRAME_MS } from './core'
import type { PetState } from './core'

type Props = {
  state: PetState
  motion: boolean
  color: string
  tongue: string
  mark: string
  mono: boolean
  /** Which animal to draw; the shiba when absent. */
  kind?: 'shiba' | 'cat'
}

type Ref = { tick: number; state: PetState; motion: boolean; stop: (() => void) | null }
type State = { ref: Ref }

const Pet: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { tick: 0, state: props.state, motion: props.motion, stop: null }
  // A new state or motion setting restarts the timer at that state's pace.
  if (surface.state === undefined || ref.state !== props.state || ref.motion !== props.motion) {
    ref.stop?.()
    ref.state = props.state
    ref.motion = props.motion
    ref.tick = 0
    ref.stop = props.motion
      ? surface.every(FRAME_MS[props.state], () => {
          ref.tick += 1
          surface.setState({ ref })
        })
      : null
    surface.setState({ ref })
  }

  const frames = (props.kind === 'cat' ? CAT_FRAMES : FRAMES)[props.state]
  const frame = (props.motion && ref.tick % 2 === 1 ? frames[1] : frames[0])
  const face = props.mono ? { mono: true } : {}
  const colorOf = (role?: string) => (role === 'tongue' ? props.tongue : role === 'mark' ? props.mark : props.color)
  return (
    <Box flexDirection="column">
      {frame.map(row => (
        <Box flexShrink={0}>
          <Text {...face}>
            {row.map(run => (
              <Text color={colorOf(run.role)} {...face}>
                {run.text}
              </Text>
            ))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export default Pet
