import React, { useEffect, useState, useRef } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, FlatList, ActivityIndicator, TouchableOpacity, useWindowDimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import { ThemedView, ThemedText } from '@/components/Themed';
import { apiListMemories, apiCreateMemory, apiDeleteMemory, MemoryItem, apiImportMemoriesFromOmi } from '@/lib/api';

export default function MemoriesScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isSmall = width <= 375;
  const [loading, setLoading] = useState<boolean>(false);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState<string>('');
  const listRef = useRef<FlatList<MemoryItem>>(null);

  async function load(initial = false) {
    setLoading(true);
    try {
      const res = await apiListMemories(50, initial ? undefined : cursor || undefined);
      if (initial) setItems(res.items);
      else setItems((prev: MemoryItem[]) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function syncFromOmi() {
    setLoading(true);
    try {
      const res = await apiImportMemoriesFromOmi();
      if (!res || !res.ok) {
        Alert.alert('Sync failed', 'Could not import from OMI');
      } else {
        await load(true);
        const imported = typeof res.imported === 'number' ? res.imported : 0;
        const skipped = typeof res.skipped === 'number' ? res.skipped : 0;
        if (imported > 0 || skipped > 0) {
          Alert.alert('Sync complete', `Imported ${imported}, skipped ${skipped}`);
        }
      }
    } catch (e: any) {
      Alert.alert('Sync error', e?.message || 'Failed to sync');
    } finally {
      setLoading(false);
    }
  }

  async function addMemory() {
    if (!text.trim()) return;
    const ok = await apiCreateMemory(text.trim());
    if (ok) {
      setText('');
      load(true);
    } else {
      Alert.alert('Failed to create memory');
    }
  }

  async function deleteMemory(id: string) {
    const ok = await apiDeleteMemory(id);
    if (!ok) {
      Alert.alert('Failed to delete memory');
      return;
    }
    setItems((prev: MemoryItem[]) => prev.filter((m) => m.id !== id));
  }

  useEffect(() => {
    load(true);
    // Auto import a small batch on first mount to keep memories fresh
    (async () => {
      try {
        const res = await apiImportMemoriesFromOmi({ pageLimit: 50, maxTotal: 200 });
        if (res && res.ok) {
          load(true);
        }
      } catch {}
    })();
  }, []);

  return (
    <ThemedView style={[styles.container, isSmall && { padding: 12 }]}>
      <ThemedText type="title">Memories</ThemedText>
      <View style={[styles.row, isSmall && { gap: 6 }]}>
        <TextInput style={[styles.input, isSmall && { paddingVertical: 8 }]} value={text} onChangeText={setText} placeholder="Add a memory..." />
        <Button title="Save" onPress={addMemory} />
      </View>
      <View style={[styles.row, isSmall && { gap: 6 }]}>
        <Button title={loading ? 'Syncing...' : 'Sync from OMI'} onPress={syncFromOmi} />
      </View>
      {loading && items.length === 0 ? <ActivityIndicator /> : null}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(m: MemoryItem) => m.id}
        renderItem={({ item }: { item: MemoryItem }) => {
          const rightActions = () => (
            <TouchableOpacity style={styles.deleteAction} onPress={() => deleteMemory(item.id)}>
              <Text style={styles.deleteText}>Delete</Text>
            </TouchableOpacity>
          );
          // On web, avoid react-native-gesture-handler Swipeable which relies on findNodeHandle
          if (Platform.OS === 'web') {
            return (
              <View style={styles.cardRow}>
                <View style={[styles.card, { flex: 1 }]}>
                  <Text style={styles.cardText}>{item.text}</Text>
                  <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
                </View>
                <TouchableOpacity style={[styles.deleteAction, { marginLeft: 8, height: '100%' }]} onPress={() => deleteMemory(item.id)}>
                  <Text style={styles.deleteText}>Delete</Text>
                </TouchableOpacity>
              </View>
            );
          }
          return (
            <Swipeable renderRightActions={rightActions} overshootRight={false}>
              <View style={styles.card}>
                <Text style={styles.cardText}>{item.text}</Text>
                <Text style={styles.cardMeta}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
            </Swipeable>
          );
        }}
        contentContainerStyle={{ paddingBottom: 12 + Math.max(insets.bottom, 8) }}
        ListFooterComponent={() => (
          cursor ? <Button title={loading ? 'Loading...' : 'Load more'} onPress={() => load(false)} /> : <Text style={styles.cardMeta}>No more</Text>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 8 },
  card: { borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', borderRadius: 8, padding: 12, marginBottom: 8 },
  cardText: { fontSize: 16 },
  cardMeta: { color: '#666', marginTop: 6 },
  deleteAction: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#ff4d4f', paddingHorizontal: 16, borderRadius: 8, marginBottom: 8 },
  deleteText: { color: '#fff', fontWeight: '700' },
});

