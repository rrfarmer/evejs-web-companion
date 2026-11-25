import carbonui.const as uiconst
from carbonui.primitives.container import Container
from eve.client.script.ui.shared.traits import HasTraits, TraitsContainer
from carbon.common.script.util.commonutils import StripTags


def observe():
    root = Container(parent=uicore.layer.main, state=uiconst.UI_HIDDEN)
    try:
        entries = {}
        for type_id in (32880, 24698, 583, 34, 483):
            if HasTraits(type_id):
                traits = TraitsContainer(parent=root, typeID=type_id)
                entries[str(type_id)] = [[StripTags(part).strip() for part in child.text.split('<t>', 1)]
                                         for child in traits.children]
            else:
                entries[str(type_id)] = None
        return {'station': session.stationid, 'entries': entries}
    finally:
        root.Close()


result = observe()
