from eve.client.script.ui.shared.inventory.plexVault import PlexVaultController


controller = PlexVaultController()
item = controller._GetFakePlexItem()
labels = []
for entry in controller.GetItemMenu():
    if isinstance(entry, (tuple, list)) and entry:
        label = entry[0]
        labels.append(unicode(label[0] if isinstance(label, tuple) else label))
    elif entry and hasattr(entry, 'GetTextDescriptive'):
        labels.append(unicode(entry.GetTextDescriptive()))

result = {'station': session.stationid, 'typeID': item.typeID, 'balance': item.stacksize,
          'inVault': item.isInPlexVault, 'labels': labels}
