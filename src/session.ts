// One muse session per running Pi process: cheap, correct enough. If Pi
// restarts and resumes an old saved session, this cold-starts a new muse
// session too — that just costs one extra full-history fold, not a bug.
export interface MuseSessionTurn {
	sessionId: string;
	isFirstTurn: boolean;
}

export function createMuseSessionTracker(generateId: () => string = () => crypto.randomUUID()) {
	let sessionId: string | undefined;
	return function nextTurn(): MuseSessionTurn {
		const isFirstTurn = sessionId === undefined;
		if (sessionId === undefined) sessionId = generateId();
		return { sessionId, isFirstTurn };
	};
}
