import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SpringPressableProps
  extends Omit<
    PressableProps,
    'children' | 'onLongPress' | 'onPress' | 'style'
  > {
  children: ReactNode;
  onLongPress?: PressableProps['onLongPress'];
  onPress?: PressableProps['onPress'];
  pressedScale?: number;
  style?: StyleProp<ViewStyle>;
}

export function SpringPressable({
  children,
  disabled,
  onLongPress,
  onPress,
  onPressIn,
  onPressOut,
  pressedScale = 0.978,
  style,
  ...pressableProps
}: SpringPressableProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const animate = useCallback(
    (pressed: boolean) => {
      if (reduceMotion) {
        scale.setValue(1);
        opacity.setValue(pressed ? 0.92 : 1);
        return;
      }
      Animated.parallel([
        Animated.spring(scale, {
          damping: pressed ? 26 : 22,
          mass: 0.72,
          stiffness: pressed ? 430 : 360,
          toValue: pressed ? pressedScale : 1,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(opacity, {
          duration: pressed ? 90 : 150,
          toValue: pressed ? 0.94 : 1,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    },
    [opacity, pressedScale, reduceMotion, scale],
  );

  return (
    <AnimatedPressable
      {...pressableProps}
      disabled={disabled}
      onLongPress={onLongPress}
      onPress={onPress}
      onPressIn={(event) => {
        animate(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animate(false);
        onPressOut?.(event);
      }}
      style={[
        style,
        {
          opacity,
          transform: [{ scale }],
        },
      ]}
    >
      {children}
    </AnimatedPressable>
  );
}
