import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel owners 13536'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    target = 140000001
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
        window.OnOwnersTab()
        before = chat.GetUsersWithAffiliation(room, 'owner')
        window._RemoveOwner([session.charid])
        last_owner = chat.GetUsersWithAffiliation(room, 'owner')
        chat.SetAffiliation(room, target, 'owner')
        window.PopulateOwnersList()
        added = chat.GetUsersWithAffiliation(room, 'owner')
        window._RemoveOwner([target])
        return dict(station=session.stationid, actor=session.charid, target=target, before=before,
                    lastOwner=last_owner, added=added, after=chat.GetUsersWithAffiliation(room, 'owner'),
                    members=chat.GetUsersWithAffiliation(room, 'member'),
                    labels=[GetByLabel(path) for path in ('UI/Chat/Owners', 'UI/Chat/AddToOwnerList', 'UI/Chat/RemoveSelected')])
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
