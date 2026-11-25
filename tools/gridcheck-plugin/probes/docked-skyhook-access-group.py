# Read native access-group drag and Skyhook drop behavior without saving a setting.
from localization import GetByLabel
from ownergroups.client.link import format_access_group_url
from eve.client.script.ui.structure.accessGroups.accessGroupEntry import AccessGroupEntry
from eve.client.script.ui.shared.bookmarks.bookmarkContainerWindow import DropCombo
from utillib import KeyVal

group = KeyVal(groupID=1234, sr=KeyVal(node=KeyVal(groupInfo=KeyVal(name='Fixture list'))))
row = AccessGroupEntry.GetDragData.im_func(group)[0]
link = format_access_group_url(5678)
text = KeyVal(__guid__='TextLink', url=link)
invalid = KeyVal(__guid__='TextLink', url='showinfo:81080//9988400004071')
accepted = []
for nodes in ([row, text], [text], [invalid]):
    DropCombo.OnDropData.im_func(KeyVal(OnDroppedData=lambda groupID: accepted.append(groupID)), None, nodes)
result = {'title': GetByLabel('UI/Structures/AccessGroups/GroupWndName'),
          'row': [row.nodeType, row.groupID, row.label], 'link': link, 'accepted': accepted}
