import blue
import localization
from carbonui import uiconst
from eve.common.lib import appConst
from eve.client.script.ui.station.agents.agentDialogueWindow import AgentDialogueWindow
from jobboard.client import get_agent_mission_job


def observe_tracking(agent_id):
    job = get_agent_mission_job(agent_id)
    if not job or not job.is_trackable:
        raise RuntimeError('Native agent job is missing or untrackable')
    provider = job.provider
    original = dict(provider.get_tracked_job_ids())
    try:
        initial = bool(job.is_tracked)
        job.toggle_tracked_by_player()
        after = bool(job.is_tracked)
        job.toggle_tracked_by_player()
        return dict(jobID=job.job_id, before=initial, after=after, restored=bool(job.is_tracked),
                    accepted=bool(job.is_accepted), setting=provider._tracked_setting_id)
    finally:
        provider._set_tracked_job_ids(original)


def observe():
    agents = sm.GetService('agents')
    agent_id = 3012018
    second_id = 3016815
    journal = sm.GetService('journal')
    existing = {row[4] for row in journal.GetMyAgentJournalDetails()[0]}
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
        agents.OpenDialogueWindow(second_id)
        second = agents.agentDialogWindows.get(second_id)
        if not second or second.destroyed or window.destroyed:
            raise RuntimeError('Two agent conversation windows did not stay open')
        observed = dict(build=3698585, station=session.stationid, agent=agent_id,
                    windowID=window.windowID, caption=window.GetCaption(),
                    dimensions=[AgentDialogueWindow.default_width, AgentDialogueWindow.default_height],
                    minimum=list(AgentDialogueWindow.default_minSize),
                    panes=bool(window.leftPane and window.rightPane),
                    secondID=second.windowID, secondCaption=second.GetCaption())
        def buttons():
            return [getattr(button, 'label', None) for button in window.buttonGroup.buttons]

        observed['offerButtons'] = buttons()
        observed['tracking'] = observe_tracking(agent_id)
        observed['footer'] = window.buttonGroup.align == uiconst.TOBOTTOM
        window.ReconstructButtons([(1, appConst.agentDialogueButtonQuit)], {})
        observed['quitButtons'] = buttons()
        window.ReconstructButtons([(1, appConst.agentDialogueButtonAccept)], {'missionCantReplay': 10000000})
        observed['replayButtons'] = buttons()
        cooldowns = []
        for ticks in (450000000, 1250000000):
            html = window.GetBriefingHTML([], 'replacement marker', {'missionCantReplay': ticks})
            window.SetSinglePaneView(briefingHtml=html)
            cooldowns.append(dict(ticks=ticks, html=html, width=window.width, fixed=window._fixedWidth))
        observed['cooldowns'] = cooldowns
        observed['noMissionMessages'] = [localization.GetByLabel('UI/Agents/DefaultMessages/NoMission%d' % option)
                                         for option in (1, 2)]
        division = window.agentDivisionID
        try:
            window.agentDivisionID = appConst.corpDivisionHeraldry
            observed['heraldryReplay'] = window._GetNoMissionMessage(450000000)
        finally:
            window.agentDivisionID = division
        window.Close()
        observed['independent'] = not second.destroyed
        return observed
    finally:
        for id in (agent_id, second_id):
            window = agents.agentDialogWindows.get(id)
            if window and not window.destroyed:
                window.Close()
            if id not in existing:
                agents.RemoveOfferFromJournal(id)


result = observe()
