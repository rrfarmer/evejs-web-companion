import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchannelmenu, xmppchatsvc


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
                    labels=[GetByLabel('UI/Chat/' + key) for key in ('Channel', 'Mute', 'Unmute', 'Kick', 'LengthMinutes', 'Reason')])
    finally:
        xmppchannelmenu.HybridWnd = original_hybrid
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original_prompt


result = observe()
