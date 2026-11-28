from eve.client.script.ui.shared.planet import planetCommon


class Tooltip(object):
    def __init__(self):
        self.rows = []

    def LoadGeneric2ColumnTemplate(self):
        self.columns = 2

    def AddLabelLarge(self, **attrs):
        self.rows.append(dict(kind='title', text=attrs['text']))

    def AddLabelMedium(self, **attrs):
        self.rows.append(dict(kind='heading', text=attrs['text']))

    def AddIconLabel(self, **attrs):
        self.rows.append(dict(kind='product', text=attrs['label'], iconSize=attrs['iconSize']))


def observe():
    samples = []
    for type_id in (2268, 2267, 2305):
        tooltip = Tooltip()
        planetCommon.LoadProductTooltipPanel(tooltip, type_id)
        samples.append(dict(typeID=type_id, columns=tooltip.columns, rows=tooltip.rows,
                            outputs=planetCommon.GetRequiredForItems(type_id)))
    return dict(build=3698585, station=session.stationid, samples=samples)


result = observe()
