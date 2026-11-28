import uthread2
from eveservices.xmppchat import GetChatService
from neocom2.btnIDs import CHAT_ID
from xmppchatclient.xmppchatsvc import SESSION_CHANGE_CATEGORIES


def observe(peer):
    if not session.stationid or not session.fleetid:
        raise RuntimeError('The probe requires a docked pilot in a live fleet')
    fleet = sm.GetService('fleet')
    chat = GetChatService()
    room = 'fleet_%s' % session.fleetid
    for _ in range(60):
        window = chat.GetGroupChatWindow(room)
        members = fleet.GetMembers()
        if window and session.charid in members and peer in members and peer in window.GetMembers():
            break
        uthread2.sleep(0.25)
    else:
        raise RuntimeError('Both pilots must be in the Fleet chat and fleet roster')

    advertised = list(chat.XmppChatMgr.ResyncSystemChannelAccess())
    displayed = sorted(set(window.receiver for window in chat.groupChatWindows.values()
                           if window and not window.destroyed and window.receiver))
    node = next(item for item in sm.GetService('neocom').mainBtnDataRoot.children if item.id == CHAT_ID)
    captions = [window.GetCaption() for window in node._GetOpenChatWindows()]
    own = members[session.charid]
    other = members[peer]
    assigned = own if own.wingID > 0 and own.squadID > 0 else other
    return dict(station=session.stationid, actor=session.charid, peer=peer, fleetBoss=fleet.IsBoss(),
                fleet=session.fleetid, position=[own.wingID, own.squadID, own.role],
                peerPosition=[other.wingID, other.squadID, other.role],
                wingLabel=chat.GetDisplayName('wing_%s' % assigned.wingID),
                squadLabel=chat.GetDisplayName('squad_%s' % assigned.squadID),
                advertised=advertised, displayed=displayed, captions=captions, sessionKeys=list(SESSION_CHANGE_CATEGORIES.keys()),
                sessionCategories=list(SESSION_CHANGE_CATEGORIES.values()))


result = observe(peer)
