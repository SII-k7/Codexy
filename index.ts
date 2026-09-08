import { registerRootComponent } from 'expo';
import { createElement } from 'react';

import App from './src/FleetApp';
import HubApp from './src/HubApp';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(() => process.env.EXPO_PUBLIC_CODEXY_HUB === '1' ? createElement(HubApp) : createElement(App));
