import blue
import re
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
        html = GetMissionDetailsWindowHTML(mission, agent_id)
        links = re.findall(r'<a href=["\']?(showinfo:[^"\'\s>]+)["\']?>(.*?)</a>', html, re.I | re.S)
        colors = re.findall(r'<font\s+color\s*=\s*["\']?(#[0-9a-f]{6}|0x[0-9a-f]{8})["\']?>(.*?)</font>', html, re.I | re.S)
        bold = re.findall(r'<b>(.*?)</b>', html, re.I | re.S)
        return dict(build=3698585, station=session.stationid, agent=agent_id,
                    title=wnd.GetCaption(), dimensions=[MissionDetailsWindow.default_width, MissionDetailsWindow.default_height],
                    minimum=list(MissionDetailsWindow.default_minSize), missionState=mission['missionState'],
                    fields=sorted(mission.keys()), html=html[:8000],
                    links=[dict(url=url, text=re.sub(r'<[^>]*>', '', body).strip(),
                                image=body.startswith('<img')) for url, body in links],
                    colors=[dict(color=color, text=re.sub(r'<[^>]*>', '', text).strip())
                            for color, text in colors if text],
                    bold=bold)
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
