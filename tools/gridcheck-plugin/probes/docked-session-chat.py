import uthread2
from eveservices.xmppchat import GetChatService
from neocom2.btnIDs import CHAT_ID


def observe():
    if not session.stationid or session.fleetid:
        raise RuntimeError('This probe needs a docked pilot outside a fleet')
    chat = GetChatService()
    fleet = sm.GetService('fleet')
    node = next(item for item in sm.GetService('neocom').mainBtnDataRoot.children if item.id == CHAT_ID)

    def sample():
        return dict(fleet=session.fleetid, wing=getattr(session, 'wingid', None),
                    squad=getattr(session, 'squadid', None), alliance=session.allianceid,
                    faction=getattr(session, 'warfactionid', None),
                    rooms=sorted(chat.XmppChatMgr.ResyncSystemChannelAccess()),
                    windows=[(wnd.name, wnd.GetCaption()) for wnd in node._GetOpenChatWindows()])

    before = sample()
    try:
        fleet.CreateFleet()
        for _ in range(30):
            if session.fleetid and chat.GetGroupChatWindow('fleet_%s' % session.fleetid):
                break
            uthread2.sleep(0.2)
        joined = sample()
        wings = fleet.GetWings() or {}
        formation = [(wing_id, sorted(wing.squads.keys())) for wing_id, wing in wings.items()]
        fleet.LeaveFleet()
        for _ in range(30):
            if not session.fleetid and not any(wnd.name == 'chatchannel_fleet' for wnd in node._GetOpenChatWindows()):
                break
            uthread2.sleep(0.2)
        return dict(station=session.stationid, before=before, joined=joined, formation=formation, after=sample())
    finally:
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
