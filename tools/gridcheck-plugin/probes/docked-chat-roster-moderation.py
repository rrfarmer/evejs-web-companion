import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchannelmenu, xmppchatsvc


def observe_system_rooms(chat, target):
    rows = []
    for label, expected_operator in (('English Help', True), ('German Help', False)):
        room = chat.GetChannelByDisplayName(label)[0][0]
        was_joined = chat.IsJoined(room)
        try:
            if not was_joined:
                chat.JoinChannel(room, suppressMessage=True)
            for _ in range(40):
                if chat.memberRolesByChannels[room].get(session.charid):
                    break
                uthread2.sleep(0.25)
            role = chat.memberRolesByChannels[room].get(session.charid)
            if not role or (role == 'moderator') != expected_operator:
                raise RuntimeError('Unexpected native room role in ' + label)
            entries = xmppchannelmenu.XmppChannelMenu(room, target)
            rows.append(dict(room=room, role=role, targetPresent=target in chat.groupChatWindows[room].GetMembers(),
                             actions=[invoke.__name__ for _, submenu in entries if isinstance(submenu, list)
                                      for _, invoke in submenu]))
        finally:
            if not was_joined and chat.IsJoined(room):
                chat.LeaveChannel(room)
    return rows


def observe():
    chat = GetChatService()
    name = 'Gridcheck roster moderation 13542'
    if chat.GetChannelByDisplayName(name):
        raise RuntimeError('The moderation fixture name is already in use')
    room = chat.CreateChannel(name)
    target = 140000001
    original_prompt = xmppchatsvc.prompt_player_fsd_dialog
    original_hybrid = xmppchannelmenu.HybridWnd
    forms = []

    def cancel(fields, **options):
        forms.append(dict(window=options['windowID'], caption=options['caption'],
                          fields=[dict((key, field[key]) for key in ('key', 'setvalue', 'intonly', 'maxLength') if key in field)
                                  for field in fields if 'key' in field]))
        return None

    try:
        chat.JoinChannel(room, suppressMessage=True)
        for _ in range(30):
            if chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        commands = xmppchannelmenu.XmppChannelMenu(room, target)
        actions = next(row[1] for row in commands if isinstance(row[1], list))
        xmppchannelmenu.HybridWnd = cancel
        for _, invoke in actions:
            invoke()
        own = xmppchannelmenu.XmppChannelMenu(room, session.charid)
        return dict(station=session.stationid, actorOperator=chat.IsOperator(room, session.charid), room=room,
                    actions=[invoke.__name__ for _, invoke in actions], forms=forms, own=len(own),
                    systems=observe_system_rooms(chat, target),
                    labels=[GetByLabel('UI/Chat/' + key) for key in ('Channel', 'Mute', 'Unmute', 'Kick', 'LengthMinutes', 'Reason')])
    finally:
        xmppchannelmenu.HybridWnd = original_hybrid
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original_prompt


result = observe()
