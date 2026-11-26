import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel allowed 13532'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    target = 140000001
    cfg.eveowners.Prime([target])
    target_name = cfg.eveowners.Get(target).name
    room = chat.CreateChannel(name)
    original = xmppchatsvc.prompt_player_fsd_dialog
    window = None
    try:
        chat.JoinChannel(room, suppressMessage=True)
        for _ in range(20):
            if chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        window = ChannelSettingsDlg.Open(channel=room, windowID='ChannelSettingsDlg_%s' % room)
        window.OnAllowedTab()
        before = chat.GetUsersWithAffiliation(room, 'member')
        chat.SetAffiliation(room, target, 'member')
        window.PopulateAllowedList()
        added = chat.GetUsersWithAffiliation(room, 'member')
        window._RemoveAllowed([target])
        removed = chat.GetUsersWithAffiliation(room, 'member')
        return dict(station=session.stationid, target=target, targetName=target_name,
                    labels=[GetByLabel('UI/Chat/Allowed'), GetByLabel('UI/Chat/AddToAllowedList'),
                            GetByLabel('UI/Chat/SelectAllianceCorpChar')],
                    before=before, added=added, removed=removed)
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
