import React, { useState } from 'react';
import { StyleSheet, View, Text, Button, TextInput, Alert, ScrollView } from 'react-native';
import { ThemedView, ThemedText } from '@/components/Themed';
import { createApiClient } from '@/lib/api';

export default function ControlScreen() {
  const client = createApiClient();
  const [slot, setSlot] = useState<string>('1');
  const [text, setText] = useState<string>('');
  const [response, setResponse] = useState<string>('');

  async function send() {
    try {
      const payload: any = {};
      if (slot) payload.slot = Number(slot);
      payload.text = text;
      const { data } = await client.post('/messages/send', payload);
      setResponse(data?.assistant_text || JSON.stringify(data));
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed');
    }
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <ThemedText type="title">Control</ThemedText>
        <View style={styles.row}>
          <Text>Slot (1-5)</Text>
          <TextInput style={styles.input} value={slot} onChangeText={setSlot} keyboardType="number-pad" />
        </View>
        <View style={styles.row}>
          <Text>Message</Text>
          <TextInput style={[styles.input, { height: 80 }]} value={text} onChangeText={setText} multiline placeholder="Type a message to the assistant" />
        </View>
        <Button title="Send" onPress={send} />
        <ThemedText type="subtitle">Assistant Response</ThemedText>
        <Text selectable>{response}</Text>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 16 },
  row: { gap: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});

