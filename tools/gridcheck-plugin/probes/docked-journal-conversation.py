import blue
import localization
import re
from carbonui import uiconst
from evedungeons.client.ship_restrictions_window import ShipRestrictionsWindow
from evedungeons.client.util import GetDungeonShipRestrictionsTypeListID
from evelink.client.handlers.local_service.handler import handle_local_service_link
from eve.common.lib import appConst
from eve.client.script.ui.station.agents.agentDialogueWindow import AgentDialogueWindow
from jobboard.client import get_agent_mission_job


def observe_ship_restrictions(window, objectives):
    dungeons = objectives.get('dungeons', [])
    if not dungeons:
        return None
    dungeon_id = 2493
    source = next((row for row in dungeons if row.get('dungeonID') == dungeon_id), dungeons[0])
    html = [window._GetObjectiveHTML(dict(objectives, dungeons=[dict(source, dungeonID=dungeon_id, shipRestrictions=flag)]))
            for flag in (0, 1)]
    link = re.search(r'href=(localsvc:method=PopupDungeonShipRestrictionList[^>]+)', html[1]).group(1)
    if ShipRestrictionsWindow.GetIfOpen():
        raise RuntimeError('Ship Restrictions is already open')
    try:
        handle_local_service_link(link)
        panel = ShipRestrictionsWindow.GetIfOpen()
        if not panel or panel._dungeon_id != dungeon_id:
            raise RuntimeError('Agent objective link did not open Ship Restrictions')
        return dict(dungeon=dungeon_id, gate=panel._gate_id, caption=panel.GetCaption(),
                    typeList=GetDungeonShipRestrictionsTypeListID(dungeon_id),
                    allowed=sorted({type_id for group in panel._types_by_group.values() for type_id in group}),
                    normal=html[0], special=html[1], conversationHeld=not window.destroyed)
    finally:
        panel = ShipRestrictionsWindow.GetIfOpen()
        if panel:
            panel.Close()


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
        observed['header'] = dict(
            html=window.GetAgentHeader({}),
            withLoyalty=window.GetAgentHeader({'loyaltyPoints': 1234}))
        objective_data = window.GetAgentMoniker().GetMissionObjectiveInfo()
        if objective_data:
            observed['objectivesHTML'] = window._GetObjectiveHTML(objective_data)
            observed['shipRestrictions'] = observe_ship_restrictions(window, objective_data)
        observed['tracking'] = observe_tracking(agent_id)
        observed['footer'] = window.buttonGroup.align == uiconst.TOBOTTOM
        special = [
            (314, {'ContentID': 91000001, 'Mission Title ID': 'Gridcheck special choice',
                   'Mission Briefing ID': 'Read this choice before selecting it.', 'Mission Keywords': {'sample': 1}}),
            (315, {'ContentID': 91000002, 'Mission Title ID': 'Gridcheck corrupt choice',
                   'Mission Briefing ID': 0, 'Mission Keywords': {'sample': 1}}),
            (316, {'ContentID': 91000003, 'Mission Title ID': 'Gridcheck title only',
                   'Mission Briefing ID': None, 'Mission Keywords': {'sample': 1}}),
        ]
        try:
            special_actions = special + [(317, appConst.agentDialogueButtonAccept)]
            window.ReconstructButtons(special_actions, {})
            observed['specialInteractions'] = dict(
                html=window.GetSpecialInteractionHTML(special), mixedButtons=buttons(),
                extra=window.GetExtraMissionInfoHTML(special, agents.GetMissionBriefingInfo(agent_id)),
                corrupt=localization.GetByLabel('UI/Agents/Dialogue/StandardMission/CorruptBriefing'))
            window.ReconstructButtons(special, {})
            observed['specialInteractions']['onlyButtons'] = buttons()
        finally:
            for _, data in special:
                agents.missionArgs.pop((agent_id, data['ContentID']), None)
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
