import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchatwindow import MOTD_CHANNEL_TYPES


def observe():
    chat = GetChatService()
    title = 'Gridcheck MOTD menu 13873'
    if chat.GetChannelByDisplayName(title):
        raise RuntimeError('The temporary room already exists')
    player = chat.CreateChannel(title)
    system = chat.GetChannelByDisplayName('German Help')[0][0]
    system_was_joined = chat.IsJoined(system)
    original = xmppchatsvc.prompt_player_fsd_dialog
    label = GetByLabel('UI/Chat/ReloadChannelMOTD')
    try:
        for room in (player, system):
            if not chat.IsJoined(room):
                chat.JoinChannel(room, suppressMessage=True)
        keys = ('local', 'corp', player, system)
        for _ in range(40):
            if all(key in chat.groupChatWindows for key in keys):
                break
            uthread2.sleep(0.25)
        rows = []
        for key in keys:
            window = chat.groupChatWindows[key]
            entries = [getattr(entry, 'text', None) for entry in window.GetMenu().GetEntries()]
            rows.append(dict(room=window.receiver, present=label in entries, hasMotd=bool(window.GetMotd()),
                             canConfigure=window._should_show_channel_settings_option()))
        return dict(station=session.stationid, categories=sorted(MOTD_CHANNEL_TYPES), contextLabel=label,
                    gearLabel=GetByLabel('UI/Chat/ReloadMOTD'), rooms=rows)
    finally:
        if not system_was_joined:
            chat.LeaveChannel(system)
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(player)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
