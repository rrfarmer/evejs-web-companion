import uthread2
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient.xmppchannelmenu import XmppChannelMenu


def observe(target):
    if not session.stationid or not session.fleetid or target == session.charid:
        raise RuntimeError('A docked fleet member and a different fleet pilot are required')
    chat = GetChatService()
    room = 'fleet_%s' % session.fleetid
    for _ in range(40):
        window = chat.GetGroupChatWindow(room)
        if window and target in window.GetMembers() and session.charid in window.GetMembers():
            break
        uthread2.sleep(0.25)
    else:
        raise RuntimeError('Both fleet pilots must be in the live chat roster')
    entries = XmppChannelMenu(room, target)
    roles = chat.memberRolesByChannels[room]
    return dict(station=session.stationid, room=room, actor=session.charid, target=target,
                fleetBoss=sm.GetService('fleet').IsBoss(), actorRole=roles.get(session.charid),
                targetRole=roles.get(target), actorOperator=chat.IsOperator(room, session.charid),
                targetOperator=chat.IsOperator(room, target),
                actions=[invoke.__name__ for _, invoke in entries if callable(invoke)],
                channelActions=[invoke.__name__ for _, submenu in entries if isinstance(submenu, list)
                                for _, invoke in submenu],
                settings=GetByLabel('UI/Chat/Configuration') in
                [getattr(entry, 'text', None) for entry in window.GetMenu().GetEntries()])


result = observe(target)
