from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from globalConfig.getFunctions import IsContentComplianceControlSystemActive
from localization import GetByLabel
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg, GetFieldsFromConfig


def observe():
    chat = GetChatService()
    window = chat.groupChatWindows['corp']
    room = window.receiver
    entries = []
    window.MaybeAddSettingsOptionsToMenuParent(Bunch(AddIconEntry=lambda **kw: entries.append(kw)))
    eligible = window._should_show_channel_settings_option()
    result = dict(station=session.stationid, room=room, corpRole=str(session.corprole),
                  chatManager=bool(session.corprole & const.corpRoleChatManager),
                  compliance=IsContentComplianceControlSystemActive(sm.GetService('machoNet')),
                  eligible=eligible, gear=[entry['text'] for entry in entries],
                  context=GetByLabel('UI/Chat/Configuration') in
                  [getattr(entry, 'text', None) for entry in window.GetMenu().GetEntries()],
                  fields=sorted(GetFieldsFromConfig(chat.GetChannelConfig(room)) or {}))
    if entries:
        entries[0]['callback']()
        dialog = ChannelSettingsDlg.GetIfOpen(windowID='ChannelSettingsDlg_%s' % room)
        if dialog:
            try:
                result['dialog'] = dict(name=dialog.channelName.GetValue(), operatorOnly=dialog.operatorOnly,
                                        access=dialog.accessTypeCombo.GetValue() if not dialog.operatorOnly else None,
                                        motd=dialog.motd.GetValue())
            finally:
                dialog.Close()
    return result


result = observe()
