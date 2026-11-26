import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from xmppchatclient import xmppchatchannels, xmppchatsvc


def observe():
    window_class = xmppchatchannels.XmppChatChannels
    if window_class.GetIfOpen():
        return {'alreadyOpen': True}
    chat = GetChatService()
    name = 'Gridcheck channel creation 13529'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    prompts = []
    should_create = [False]

    def record(key, values=None, buttons=None):
        prompts.append(key)
        if key == 'LSCChannelDoesNotExistCreate' and should_create[0]:
            return uiconst.ID_YES
        return uiconst.ID_NO

    original = xmppchatchannels.prompt_player_fsd_dialog
    original_delete = xmppchatsvc.prompt_player_fsd_dialog
    window = window_class.Open()
    try:
        xmppchatchannels.prompt_player_fsd_dialog = record
        window.input.SetValue('English Help')
        window.CreateChannelFromBtn()
        existing = list(prompts)
        del prompts[:]
        window.input.SetValue(name)
        window.JoinChannelFromBtn(None)
        declined = list(prompts)
        absent = not chat.GetChannelByDisplayName(name)
        del prompts[:]
        should_create[0] = True
        window.JoinChannelFromBtn(None)
        room = None
        for _ in range(20):
            rows = chat.GetChannelByDisplayName(name)
            if rows:
                room = rows[0][0]
                if chat.IsJoined(room):
                    break
            uthread2.sleep(0.2)
        return dict(station=session.stationid, existing=existing, declined=declined,
                    absent=absent, accepted=list(prompts), room=room, joined=bool(room and chat.IsJoined(room)))
    finally:
        xmppchatchannels.prompt_player_fsd_dialog = original
        try:
            rows = chat.GetChannelByDisplayName(name)
            if rows:
                xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
                chat.DeleteChannel(rows[0][0])
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original_delete
            window.Close()


result = observe()
