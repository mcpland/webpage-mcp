import type { AgentThread } from '../../composables/useAgentThreads';
import AgentRequestThread from './AgentRequestThread';

type AgentConversationProps = {
  threads: AgentThread[];
  serverPort?: number | null;
};

export default function AgentConversation({ threads, serverPort }: AgentConversationProps) {
  return (
    <div className="px-5 py-6 space-y-8">
      {threads.length === 0 ? (
        <div className="py-10 text-center">
          <p
            className="text-2xl italic opacity-40"
            style={{
              fontFamily: 'var(--ac-font-heading)',
              color: 'var(--ac-text-subtle)',
            }}
          >
            How can I help you code today?
          </p>
        </div>
      ) : null}

      {threads.map((thread) => (
        <AgentRequestThread key={thread.id} thread={thread} serverPort={serverPort} />
      ))}
    </div>
  );
}
