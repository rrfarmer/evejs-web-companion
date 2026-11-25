from eve.client.script.ui.shared.userentry import User
from utillib import KeyVal


def observe():
    pilots = [session.charid, 140000001 if session.charid != 140000001 else 140000002]
    cfg.eveowners.Prime(pilots)
    panel = KeyVal(isContactList=None, sr=KeyVal(node=KeyVal(Get=lambda key, default: default)))
    menu = User._GetMultiMenu.im_func(panel, [
        KeyVal(charID=pilot, listGroupID=None) for pilot in pilots])
    labels = []
    for entry in menu:
        if not entry:
            continue
        if isinstance(entry, (tuple, list)):
            label = entry[0]
            labels.append(unicode(label[0] if isinstance(label, tuple) else label))
        else:
            labels.append(unicode(entry.GetTextDescriptive()))
    return {'station': session.stationid, 'pilots': pilots, 'menu': labels}


result = observe()
