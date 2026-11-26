import uthread2
from carbonui import const as uiconst
from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchannelfield, xmppchatsvc


def menu_actions(room):
    names = ['JoinChannel', 'LeaveChannel', 'Settings', 'ForgetChannel', 'DeleteChannel']
    proxy = Bunch(sr=Bunch(node=Bunch(channel=room)), OnClick=lambda: None)
    for name in names:
        proxy[name] = lambda: None
    actions = xmppchannelfield.XmppChannelField.GetMenu.im_func(proxy)
    return [next(name for name in names if proxy[name] is entry[1]) for entry in actions]


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel destruction 13530'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    room = chat.CreateChannel(name)
    prompts = []
    accepted = [False]

    def answer(key, values=None, buttons=None):
        prompts.append(key)
        return uiconst.ID_YES if accepted[0] else uiconst.ID_NO

    original = xmppchatsvc.prompt_player_fsd_dialog
    try:
        xmppchatsvc.prompt_player_fsd_dialog = answer
        chat.JoinChannel(room)
        for _ in range(20):
            if chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        joined = menu_actions(room)
        chat.DeleteChannel(room)
        retained = bool(chat.IsJoined(room) and chat.GetChannelByDisplayName(name))
        chat.LeaveChannel(room)
        for _ in range(20):
            if not chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        owned = menu_actions(room)
        accepted[0] = True
        chat.DeleteChannel(room)
        return dict(station=session.stationid, room=room, joined=joined, owned=owned,
                    retained=retained, deleted=not chat.GetChannelByDisplayName(name), prompts=list(prompts),
                    label=GetByLabel('UI/Chat/ChannelWindow/DeleteChannel'))
    finally:
        try:
            if chat.GetChannelByDisplayName(name):
                accepted[0] = True
                chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
