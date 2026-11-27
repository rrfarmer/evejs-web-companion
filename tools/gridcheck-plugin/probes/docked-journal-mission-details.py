import blue
from eve.client.script.ui.station.agents import agents as agents_module
from eve.client.script.ui.station.agents.agentDialogueUtil import GetMissionDetailsWindowHTML
from eve.client.script.ui.station.agents.missionDetailsWindow import MissionDetailsWindow


def observe():
    svc = sm.GetService('agents')
    journal = sm.GetService('journal')
    agent_id = 3012018
    existing = next((row for row in journal.GetMyAgentJournalDetails()[0] if row[4] == agent_id), None)
    original = agents_module.are_missions_in_job_board_available
    try:
        agents_module.are_missions_in_job_board_available = lambda: False
        if existing is None:
            svc.OpenDialogueWindow(agent_id)
        mission = None
        for _ in range(55):
            mission = svc.GetMissionInfo(agent_id)
            if mission:
                break
            blue.pyos.synchro.SleepWallclock(200)
        if not mission:
            raise RuntimeError('No mission available from local agent')
        svc.PopupMission(agent_id)
        for _ in range(30):
            wnd = svc.missionDetailsWindows.get(agent_id)
            if wnd and wnd.agentID == agent_id:
                break
            blue.pyos.synchro.SleepWallclock(100)
        return dict(build=3698585, station=session.stationid, agent=agent_id,
                    title=wnd.GetCaption(), dimensions=[MissionDetailsWindow.default_width, MissionDetailsWindow.default_height],
                    minimum=list(MissionDetailsWindow.default_minSize), missionState=mission['missionState'],
                    fields=sorted(mission.keys()), html=GetMissionDetailsWindowHTML(mission, agent_id)[:8000])
    finally:
        agents_module.are_missions_in_job_board_available = original
        if agent_id in svc.missionDetailsWindows:
            svc.missionDetailsWindows[agent_id].Close()
        if existing is None:
            try:
                svc.RemoveOfferFromJournal(agent_id)
            except Exception:
                pass


result = observe()
