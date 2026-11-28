import uthread2
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient.xmppchannelmenu import XmppChannelMenu


def observe(peer, line):
    if not session.stationid:
        raise RuntimeError('The Militia probe requires a docked pilot')
    chat = GetChatService()
    room = 'faction_%s' % session.warfactionid if session.warfactionid else None
    window = chat.groupChatWindows.get('faction')
    if room:
        for _ in range(60):
            window = chat.groupChatWindows.get('faction')
            if window and window.receiver == room and (not peer or peer in window.GetMembers()):
                if not line or any(sender == peer and line in text for sender, text, _, _ in window.messages):
                    break
            uthread2.sleep(0.25)
        else:
            raise RuntimeError('The expected militia room, peer, or line did not arrive')
    entries = XmppChannelMenu(room, peer) if window and peer else []
    return dict(station=session.stationid, actor=session.charid, corporation=session.corpid,
                faction=session.warfactionid, room=window.receiver if window else None,
                label=chat.GetDisplayName(window.receiver) if window else None,
                role=chat.memberRolesByChannels[room].get(session.charid) if room else None,
                settings=window._should_show_channel_settings_option() if window else False,
                reload=bool(window and GetByLabel('UI/Chat/ReloadChannelMOTD') in
                            [getattr(entry, 'text', None) for entry in window.GetMenu().GetEntries()]),
                roster=sorted(window.GetMembers()) if window else [],
                report=any(callable(invoke) and invoke.__name__ == 'ReportISKSpammer' for _, invoke in entries),
                moderation=[invoke.__name__ for _, submenu in entries if isinstance(submenu, list)
                            for _, invoke in submenu],
                received=bool(line and any(sender == peer and line in text for sender, text, _, _ in window.messages)))


result = observe(globals().get('peer'), globals().get('line'))
