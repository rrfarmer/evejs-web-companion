import blue
from eve.client.script.ui.station.agents.agentDialogueWindow import AgentDialogueWindow


def observe():
    agents = sm.GetService('agents')
    agent_id = 3012018
    journal = sm.GetService('journal')
    existing = next((row for row in journal.GetMyAgentJournalDetails()[0] if row[4] == agent_id), None)
    try:
        agents.OpenDialogueWindow(agent_id)
        window = None
        for _ in range(40):
            window = agents.agentDialogWindows.get(agent_id)
            if window and not window.destroyed:
                break
            blue.pyos.synchro.SleepWallclock(100)
        if not window:
            raise RuntimeError('Agent conversation did not open')
        agents.OpenDialogueWindow(agent_id)
        return dict(build=3698585, station=session.stationid, agent=agent_id,
                    windowID=window.windowID, caption=window.GetCaption(),
                    dimensions=[AgentDialogueWindow.default_width, AgentDialogueWindow.default_height],
                    minimum=list(AgentDialogueWindow.default_minSize),
                    panes=bool(window.leftPane and window.rightPane),
                    reused=agents.agentDialogWindows.get(agent_id) is window)
    finally:
        window = agents.agentDialogWindows.get(agent_id)
        if window and not window.destroyed:
            window.Close()
        if existing is None:
            agents.RemoveOfferFromJournal(agent_id)


result = observe()
