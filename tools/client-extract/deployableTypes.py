# The types the 3698585 client deploys when dropped on space (navigation.OnDropData: spacecomponents HasDeployComponent,
# then deploy.DeployAction - LaunchFromShip with maxQty 1, CannotDeployRequireFleet where the component requiresFleet
# and the pilot has no fleet), and the space components the in-space menu asks of a thing (menusvc._CelestialMenu:
# activate, cargoBay - Open Cargo, its accessRange and allowFreeForAll -, scoop - Scoop to Cargo Hold -, fitting - Use Fitting Service, its range). Read from a running
# client:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/deployableTypes.py
# The page reads it as _local/client-assets/<build>/deployableTypes.json:
#   {source, types: [[typeID, requiresFleet], ...], components: {activate: [typeID...], scoop: [...], cargoBay: {typeID: [accessRange, allowFreeForAll]}, fitting: {typeID: range}}}.
from spacecomponents.common.componentConst import DEPLOY_CLASS
from spacecomponents.common.data import get_space_component_for_type, get_type_ids_with_space_component
out = []
for typeID in get_type_ids_with_space_component(DEPLOY_CLASS):
    attrs = get_space_component_for_type(typeID, DEPLOY_CLASS)
    out.append([int(typeID), bool(getattr(attrs, 'requiresFleet', False))])
components = {}
for name in ('activate', 'scoop'):
    components[name] = sorted(int(t) for t in get_type_ids_with_space_component(name))
components['cargoBay'] = dict((str(int(t)), [float(get_space_component_for_type(t, 'cargoBay').accessRange), bool(getattr(get_space_component_for_type(t, 'cargoBay'), 'allowFreeForAll', False))]) for t in get_type_ids_with_space_component('cargoBay'))
components['fitting'] = dict((str(int(t)), float(get_space_component_for_type(t, 'fitting').range)) for t in get_type_ids_with_space_component('fitting'))
result = {'types': sorted(out), 'components': components}
