import uthread2
from carbonui import const as uiconst
from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelfield import XmppChannelField


def menu_actions(room):
    names = ('JoinChannel', 'LeaveChannel', 'Settings', 'ForgetChannel', 'DeleteChannel')
    proxy = Bunch(sr=Bunch(node=Bunch(channel=room)), OnClick=lambda: None)
    for name in names:
        proxy[name] = lambda: None
    actions = XmppChannelField.GetMenu.im_func(proxy)
    return [next(name for name in names if proxy[name] is entry[1]) for entry in actions]


def set_joined(chat, room, joined):
    if joined:
        chat.JoinChannel(room, suppressMessage=True)
    else:
        chat.LeaveChannel(room)
    for _ in range(20):
        if bool(chat.IsJoined(room)) == joined:
            return
        uthread2.sleep(0.2)
    raise RuntimeError('Channel membership did not change')


def observe():
    chat = GetChatService()
    key = 'chatPlayerChannelsJoined'
    name = 'Gridcheck public Forget Channel'
    fallback = 'player_987654321'
    fallback_name = 'Gridcheck remembered room'
    original = dict(settings.user.ui.Get(key, {}))
    if chat.GetChannelByDisplayName(name):
        raise RuntimeError('The public fixture name is already in the directory')
    if fallback in {row[0] for row in chat.GetChannels()}:
        raise RuntimeError('The remembered fixture ID is already in the directory')
    room = chat.CreateChannel(name)
    try:
        if not chat.XmppChatMgr.GrantChannelOwnership(room):
            raise RuntimeError('The observing pilot needs to be able to recover ownership of the fixture')
        set_joined(chat, room, True)
        chat.SetAffiliation(room, 140000001, 'owner')
        chat.SetAffiliation(room, session.charid, 'member')
        if chat.IsOwnerOfChannel(room):
            raise RuntimeError('The observing pilot still owns the temporary public room')
        set_joined(chat, room, False)
        chat.ForgetChannel(room)
        unjoined = menu_actions(room)
        set_joined(chat, room, True)
        joined = menu_actions(room)
        remembered = settings.user.ui.Get(key, {}).get(room)
        set_joined(chat, room, False)
        chat.ForgetChannel(room)
        public_rows = [row for row in chat.GetChannels() if row[0] == room]
        public_exact = chat.GetChannelByDisplayName(name)
        seeded = dict(settings.user.ui.Get(key, {}))
        seeded[fallback] = fallback_name
        settings.user.ui.Set(key, seeded)
        fallback_rows = [row for row in chat.GetChannels() if row[0] == fallback]
        fallback_exact = chat.GetChannelByDisplayName(fallback_name)
        chat.ForgetChannel(fallback)
        return dict(station=session.stationid, name=name, unjoinedMenu=unjoined, joinedMenu=joined, remembered=remembered,
                    storedAfterForget=room in settings.user.ui.Get(key, {}), publicRows=public_rows,
                    publicExact=public_exact, fallbackRows=fallback_rows, fallbackExact=fallback_exact,
                    fallbackAfterForget=[row for row in chat.GetChannels() if row[0] == fallback],
                    label=GetByLabel('UI/Chat/ChannelWindow/ForgetChannel'))
    finally:
        prompt = xmppchatsvc.prompt_player_fsd_dialog
        try:
            if not chat.IsOwnerOfChannel(room):
                chat.XmppChatMgr.GrantChannelOwnership(room)
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
            if chat.GetChannelByDisplayName(name):
                raise RuntimeError('The temporary public room was not deleted')
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = prompt
            settings.user.ui.Set(key, original)


result = observe()
