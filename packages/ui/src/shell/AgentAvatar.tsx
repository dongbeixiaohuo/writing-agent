import type { AgentPersona } from './agent-personas.ts'
import css from './WritingAgentShell.module.css'

export function AgentAvatar({ persona }: { persona: AgentPersona }) {
  return <img className={css.agentAvatar} src={'/agent-avatars/' + persona + '.png'} width={36} height={36} alt="" />
}
