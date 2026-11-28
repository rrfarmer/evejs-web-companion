from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from globalConfig.getFunctions import IsContentComplianceControlSystemActive
from localization import GetByLabel
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg, GetFieldsFromConfig


def observe():
    chat = GetChatService()
    window = chat.groupChatWindows.get('alliance')
    result = dict(station=session.stationid, alliance=session.allianceid, corporation=session.corpid,
                  compliance=IsContentComplianceControlSystemActive(sm.GetService('machoNet')),
                  chatManager=bool(session.corprole & const.corpRoleChatManager), hasTab=bool(window))
    if not window:
        return result
    room = window.receiver
    entries = []
    window.MaybeAddSettingsOptionsToMenuParent(Bunch(AddIconEntry=lambda **kw: entries.append(kw)))
    labels = [getattr(row, 'text', None) for row in window.GetMenu().GetEntries()]
    info = sm.GetService('alliance').GetAlliance()
    result.update(room=room, executor=info.executorCorpID if info else None, gear=[row['text'] for row in entries],
                  context=GetByLabel('UI/Chat/Configuration') in labels,
                  fields=sorted(GetFieldsFromConfig(chat.GetChannelConfig(room)) or {}))
    if entries:
        entries[0]['callback']()
        dialog = ChannelSettingsDlg.GetIfOpen(windowID='ChannelSettingsDlg_%s' % room)
        if dialog:
            try:
                result.update(name=dialog.channelName.GetValue(), operatorOnly=dialog.operatorOnly, motd=dialog.motd.GetValue())
            finally:
                dialog.Close()
    return result


result = observe()
