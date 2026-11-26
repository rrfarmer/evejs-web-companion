import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg, GetFieldsFromConfig


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel settings 13531'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
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
        settings = dict(station=session.stationid, name=window.channelName.GetValue(),
                        access=window.accessTypeCombo.GetValue(), operatorOnly=window.operatorOnly,
                        labels=[GetByLabel(label) for label in ('UI/Chat/ChannelName', 'UI/Chat/Password',
                                'UI/Chat/RetypePassword', 'UI/Chat/DefaultAccess', 'UI/Chat/Motd')])
        window.channelName.SetValue(name + ' renamed')
        window.accessTypeCombo.SelectItemByValue('moderated')
        window.motd.SetValue('Gridcheck channel message')
        window.OnOK()
        form = GetFieldsFromConfig(chat.GetChannelConfig(room))
        settings.update(savedName=form.get('muc#roomconfig_roomname'),
                        membersByDefault=bool(form.get('members_by_default')),
                        membersOnly=bool(form.get('muc#roomconfig_membersonly')),
                        motd=chat.GetMotd(room))
        return settings
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
