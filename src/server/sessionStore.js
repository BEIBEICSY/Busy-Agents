export function createSessionStore() {
  const previous = new Map();

  return {
    update(currentSessions) {
      const currentIds = new Set(currentSessions.map((session) => session.id));

      for (const id of previous.keys()) {
        if (!currentIds.has(id)) previous.delete(id);
      }

      for (const session of currentSessions) {
        previous.set(session.id, session);
      }

      return currentSessions;
    }
  };
}
