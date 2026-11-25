import carbonui.const as uiconst
from carbonui.primitives.container import Container
from eve.client.script.ui.shared.market.requirements import RequirementsContainer


def observe():
    root = Container(parent=uicore.layer.main, state=uiconst.UI_HIDDEN)
    try:
        result = {}
        for type_id in (34, 483, 487, 32880, 3380, 3386):
            entry = RequirementsContainer(parent=root, typeID=type_id)
            rows = []
            for child in entry.children:
                children = [child] + list(getattr(child, 'children', []))
                rows += [{'name': elt.name, 'texture': getattr(elt, 'texturePath', None),
                          'hint': getattr(elt, 'hint', None), 'text': getattr(elt, 'text', None)}
                         for elt in children]
            result[str(type_id)] = rows
        return {'station': session.stationid, 'rows': result}
    finally:
        root.Close()


result = observe()
