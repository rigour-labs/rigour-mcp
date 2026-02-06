/**
 * Agent Sessions - Multi-agent session management for hosted MCP
 * 
 * Enables Rigour to supervise multiple AI agents working together
 * on the same codebase (Opus 4.6 agent teams, GPT-5.3 coworking mode).
 * 
 * @since v2.14.0
 */

export interface AgentRegistration {
    agentId: string;
    taskScope: string[];  // Glob patterns for files this agent owns
    registeredAt: Date;
    lastCheckpoint?: Date;
    status: 'active' | 'idle' | 'completed';
}

export interface CheckpointEntry {
    checkpointId: string;
    agentId: string;
    timestamp: Date;
    progressPct: number;
    filesChanged: string[];
    summary: string;
    qualityScore: number;
    warnings: string[];
}

export interface AgentSession {
    sessionId: string;
    agents: Map<string, AgentRegistration>;
    checkpoints: CheckpointEntry[];
    createdAt: Date;
    lastActivity: Date;
    status: 'active' | 'completed' | 'aborted';
}

/**
 * In-memory session store for hosted MCP.
 * For stateless deployments, this would be backed by Redis or similar.
 */
const sessions: Map<string, AgentSession> = new Map();

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique checkpoint ID
 */
function generateCheckpointId(): string {
    return `cp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get or create a session for a project
 */
export function getOrCreateSession(cwd: string): AgentSession {
    // Use cwd as session key for simplicity
    const existingSession = sessions.get(cwd);
    if (existingSession && existingSession.status === 'active') {
        return existingSession;
    }

    const newSession: AgentSession = {
        sessionId: generateSessionId(),
        agents: new Map(),
        checkpoints: [],
        createdAt: new Date(),
        lastActivity: new Date(),
        status: 'active',
    };

    sessions.set(cwd, newSession);
    return newSession;
}

/**
 * Register an agent in a session
 */
export function registerAgent(
    cwd: string,
    agentId: string,
    taskScope: string[]
): { success: boolean; session: AgentSession; error?: string } {
    const session = getOrCreateSession(cwd);

    // Check for task scope conflicts
    for (const [existingId, existing] of session.agents) {
        if (existingId === agentId) continue;

        const overlapping = taskScope.filter(scope =>
            existing.taskScope.some(s => s === scope || scope.startsWith(s) || s.startsWith(scope))
        );

        if (overlapping.length > 0) {
            return {
                success: false,
                session,
                error: `Task scope conflict with agent ${existingId}: ${overlapping.join(', ')}`,
            };
        }
    }

    const registration: AgentRegistration = {
        agentId,
        taskScope,
        registeredAt: new Date(),
        status: 'active',
    };

    session.agents.set(agentId, registration);
    session.lastActivity = new Date();

    return { success: true, session };
}

/**
 * Record a checkpoint for an agent
 */
export function recordCheckpoint(
    cwd: string,
    agentId: string,
    progressPct: number,
    filesChanged: string[],
    summary: string,
    qualityScore: number
): { continue: boolean; warnings: string[]; checkpointId: string } {
    const session = getOrCreateSession(cwd);
    const agent = session.agents.get(agentId);

    const warnings: string[] = [];

    // Check if agent is registered
    if (!agent) {
        warnings.push(`Agent ${agentId} not registered in session`);
    }

    // Check quality threshold (default 80%)
    const qualityThreshold = 80;
    const shouldContinue = qualityScore >= qualityThreshold;

    if (!shouldContinue) {
        warnings.push(`Quality score ${qualityScore} below threshold ${qualityThreshold}`);
    }

    // Detect drift (quality degradation over time)
    const recentCheckpoints = session.checkpoints
        .filter(cp => cp.agentId === agentId)
        .slice(-3);

    if (recentCheckpoints.length >= 2) {
        const avgPrevScore = recentCheckpoints.reduce((sum, cp) => sum + cp.qualityScore, 0) / recentCheckpoints.length;
        if (qualityScore < avgPrevScore - 10) {
            warnings.push(`Drift detected: quality dropped from avg ${avgPrevScore.toFixed(0)} to ${qualityScore}`);
        }
    }

    const checkpoint: CheckpointEntry = {
        checkpointId: generateCheckpointId(),
        agentId,
        timestamp: new Date(),
        progressPct,
        filesChanged,
        summary,
        qualityScore,
        warnings,
    };

    session.checkpoints.push(checkpoint);
    session.lastActivity = new Date();

    if (agent) {
        agent.lastCheckpoint = new Date();
    }

    return {
        continue: shouldContinue,
        warnings,
        checkpointId: checkpoint.checkpointId,
    };
}

/**
 * Get session status for Studio visualization
 */
export function getSessionStatus(cwd: string): AgentSession | null {
    return sessions.get(cwd) || null;
}

/**
 * Complete a session
 */
export function completeSession(cwd: string): void {
    const session = sessions.get(cwd);
    if (session) {
        session.status = 'completed';
        for (const [, agent] of session.agents) {
            agent.status = 'completed';
        }
    }
}

/**
 * Clear all sessions (for testing)
 */
export function clearSessions(): void {
    sessions.clear();
}
