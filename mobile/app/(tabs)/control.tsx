import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, FlatList, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { DrawerLayoutAndroid, useWindowDimensions } from 'react-native';
import { ThemedView } from '@/components/Themed';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiListConversations,
  apiListMessages,
  apiSendMessage,
  apiCreateFollowup,
  apiSwitchSpace,
  apiActivateWindow,
  apiCreateMemory,
  apiCreateTask,
  apiMe,
  apiGetConversation,
  type ConversationItem,
  type MessageItem
} from '@/lib/api';
import { apiListWindows } from '@/lib/api';
import { apiGetPreferences, apiUpdatePreferences, type Preferences, apiDeleteConversation } from '@/lib/api';

type ConversationState = {
  items: ConversationItem[];
  nextCursor: string | null;
  loading: boolean;
};

type MessageState = {
  byConversationId: Record<string, { items: MessageItem[]; nextCursor: string | null; loading: boolean }>
}

export default function ChatScreen() {
  const { user } = useAuth();
  const [convos, setConvos] = useState<ConversationState>({ items: [], nextCursor: null, loading: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageState>({ byConversationId: {} });
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const pollingRef = useRef<any>(null);
  const [hasOmiLink, setHasOmiLink] = useState<boolean>(true);
  const drawerRef = useRef<DrawerLayoutAndroid>(null);
  const { width } = useWindowDimensions();
  const isWide = width >= 900;
  const [showOverlayList, setShowOverlayList] = useState<boolean>(false);
  const convosPollRef = useRef<any>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  const selectedMessages = useMemo(() => {
    if (!selectedId) return [] as MessageItem[];
    const entry = messages.byConversationId[selectedId];
    return (entry?.items || []).slice().sort((a: MessageItem, b: MessageItem) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [messages, selectedId]);

  async function loadConversations(): Promise<void> {
    setConvos((prev: ConversationState) => ({ ...prev, loading: true }));
    const res = await apiListConversations(20);
    let items = res.items;
    // Prefer currently active window's conversation if present
    try {
      const windows = await apiListWindows();
      const active = windows.find((w: any) => w.isActive && w.conversationId);
      const activeId = active?.conversationId || null;
      if (activeId && items.some((i) => i.id === activeId)) {
        setSelectedId(activeId);
      } else if (!selectedId && items.length > 0) {
        // Try default conversation from preferences
        try {
          const prefsLatest = await apiGetPreferences();
          if (prefsLatest?.defaultConversationId && items.some((i)=>i.id===prefsLatest.defaultConversationId)) {
            setSelectedId(prefsLatest.defaultConversationId);
          } else {
            setSelectedId(items[0].id);
          }
        } catch {
          setSelectedId(items[0].id);
        }
      }
      if (activeId && !items.some((i: ConversationItem) => i.id === activeId)) {
        try {
          const c = await apiGetConversation(activeId);
          if (c) items = [c, ...items];
        } catch {}
      }
    } catch {
      if (!selectedId && res.items.length > 0) setSelectedId(res.items[0].id);
    }
    setConvos({ items, nextCursor: res.nextCursor, loading: false });
  }

  async function loadMessages(conversationId: string) {
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: prev.byConversationId[conversationId]?.items || [], nextCursor: prev.byConversationId[conversationId]?.nextCursor || null, loading: true }
      }
    }));
    const res = await apiListMessages(conversationId, 100);
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [conversationId]: { items: res.items, nextCursor: res.nextCursor, loading: false }
      }
    }));
  }

  useEffect(() => { 
    loadConversations();
    (async () => {
      const me = await apiMe();
      const verified = (me?.omi_links || []).some((l: any) => l.isVerified);
      setHasOmiLink(!!verified);
      const p = await apiGetPreferences();
      if (p) setPrefs(p);
    })();
    if (convosPollRef.current) clearInterval(convosPollRef.current);
    convosPollRef.current = setInterval(loadConversations, 5000);
    return () => { if (convosPollRef.current) clearInterval(convosPollRef.current); };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadMessages(selectedId);
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      loadMessages(selectedId);
    }, 3000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [selectedId]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!selectedId) return;
    setSending(true);

    // Slash commands
    if (text.startsWith('/')) {
      const cmd = text.slice(1).trim();
      if (cmd.startsWith('notify ')) {
        const ok = await apiCreateFollowup({ conversation_id: selectedId, message: cmd.slice('notify '.length) });
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('space ')) {
        await apiSwitchSpace(cmd.slice('space '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('window ')) {
        const num = parseInt(cmd.slice('window '.length).trim(), 10);
        if (!isNaN(num)) await apiActivateWindow(num);
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('mem ')) {
        await apiCreateMemory(cmd.slice('mem '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
      if (cmd.startsWith('task ')) {
        await apiCreateTask(cmd.slice('task '.length).trim());
        setSending(false);
        setInput('');
        return;
      }
    }

    // Optimistic add user message
    const optimistic: MessageItem = {
      id: `local-${Date.now()}`,
      role: 'USER',
      text,
      source: 'FRONTEND',
      createdAt: new Date().toISOString()
    };
    setMessages((prev: MessageState) => ({
      byConversationId: {
        ...prev.byConversationId,
        [selectedId]: {
          items: [...(prev.byConversationId[selectedId]?.items || []), optimistic],
          nextCursor: prev.byConversationId[selectedId]?.nextCursor || null,
          loading: false
        }
      }
    }));
    setInput('');

    const res = await apiSendMessage({ conversation_id: selectedId, text });
    setSending(false);
    if (!res) return;
    // Refresh messages to include assistant response
    await loadMessages(selectedId);
  }, [input, sending, selectedId]);

  const renderConversation = ({ item }: { item: ConversationItem }) => {
    const active = item.id === selectedId;
    return (
      <TouchableOpacity style={[styles.conversationItem, active && styles.conversationItemActive]} onPress={() => setSelectedId(item.id)}>
        <Text style={styles.conversationTitle}>{item.title || 'Untitled'}</Text>
        {item.summary ? <Text style={styles.conversationSummary} numberOfLines={1}>{item.summary}</Text> : null}
      </TouchableOpacity>
    );
  };

  const renderMessage = ({ item }: { item: MessageItem }) => {
    const isAssistant = item.role === 'ASSISTANT';
    return (
      <View style={[styles.bubbleRow, isAssistant ? styles.left : styles.right]}>
        <View style={[styles.bubble, isAssistant ? styles.assistantBubble : styles.userBubble]}>
          <Text style={isAssistant ? styles.assistantText : styles.userText}>{item.text}</Text>
        </View>
      </View>
    );
  };

  const selectedLoading = selectedId ? messages.byConversationId[selectedId]?.loading : false;

  const drawerContent = (
    <View style={{ flex: 1, padding: 12 }}>
      <View style={styles.sidebarHeader}>
        <Text style={{ fontSize: 20, fontWeight: '800' }}>Conversations</Text>
      </View>
      {convos.loading ? <ActivityIndicator /> : (
        <FlatList<ConversationItem>
          data={convos.items}
          renderItem={renderConversation}
          keyExtractor={(c: ConversationItem) => c.id}
        />
      )}
      <View style={{ height: 12 }} />
      {prefs ? (
        <View>
          <Text style={{ fontWeight: '700', marginBottom: 6 }}>AI Behavior</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(['TRIGGER','FOLLOWUP','ALWAYS'] as const).map((mode) => (
              <TouchableOpacity key={mode} onPress={async ()=>{ const updated = await apiUpdatePreferences({ listenMode: mode }); if (updated) setPrefs(updated); }} style={[styles.badge, prefs.listenMode===mode && styles.badgeActive]}>
                <Text style={[styles.badgeText, prefs.listenMode===mode && styles.badgeTextActive]}>{mode}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ height: 8 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <TouchableOpacity onPress={async ()=>{ const updated = await apiUpdatePreferences({ injectMemories: !prefs.injectMemories }); if (updated) setPrefs(updated); }} style={[styles.badge, prefs.injectMemories && styles.badgeActive]}>
              <Text style={[styles.badgeText, prefs.injectMemories && styles.badgeTextActive]}>Memories</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={async ()=>{ const updated = await apiUpdatePreferences({ meetingTranscribe: !prefs.meetingTranscribe }); if (updated) setPrefs(updated); }} style={[styles.badge, prefs.meetingTranscribe && styles.badgeActive]}>
              <Text style={[styles.badgeText, prefs.meetingTranscribe && styles.badgeTextActive]}>Meeting Transcribe</Text>
            </TouchableOpacity>
            {selectedId ? (
              <TouchableOpacity onPress={async ()=>{ const updated = await apiUpdatePreferences({ defaultConversationId: selectedId }); if (updated) setPrefs(updated); }} style={[styles.badge, prefs.defaultConversationId===selectedId && styles.badgeActive]}>
                <Text style={[styles.badgeText, prefs.defaultConversationId===selectedId && styles.badgeTextActive]}>Set Default</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );

  if (isWide) {
    // Desktop/tablet layout with static sidebar
    return (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemedView style={styles.container}>
          <View style={styles.sidebar}>
            <View style={styles.sidebarHeader}>
              <Text style={{ fontSize: 22, fontWeight: '800' }}>Chat</Text>
            </View>
            {convos.loading ? <ActivityIndicator /> : (
              <FlatList<ConversationItem>
                data={convos.items}
                renderItem={renderConversation}
                keyExtractor={(c: ConversationItem) => c.id}
              />
            )}
          </View>
          <View style={styles.chatArea}>
            {!hasOmiLink ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText}>Tip: Link your OMI account in Settings to receive live notifications.</Text>
              </View>
            ) : null}
            {!selectedId ? (
              <View style={styles.emptyState}>
                <Text>Select a conversation</Text>
              </View>
            ) : (
              <>
                <FlatList<MessageItem>
                  style={styles.messageList}
                  contentContainerStyle={{ padding: 12 }}
                  data={selectedMessages}
                  renderItem={renderMessage}
                  keyExtractor={(m: MessageItem) => m.id}
                />
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.textInput}
                    placeholder="Type a message or /notify ..."
                    value={input}
                    onChangeText={setInput}
                    multiline
                  />
                  <TouchableOpacity style={styles.sendBtn} onPress={onSend} disabled={sending || !input.trim()}>
                    <Text style={styles.sendBtnText}>{sending ? '...' : 'Send'}</Text>
                  </TouchableOpacity>
                  {selectedId ? (
                    <TouchableOpacity style={styles.deleteBtn} onPress={async ()=>{ const ok = await apiDeleteConversation(selectedId); if (ok) { setConvos((prev: ConversationState)=>({ ...prev, items: prev.items.filter((i: ConversationItem)=>i.id!==selectedId) })); setSelectedId(null); } }}>
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </>
            )}
          </View>
        </ThemedView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {Platform.OS === 'android' ? (
        <DrawerLayoutAndroid
          ref={drawerRef}
          drawerWidth={260}
          drawerPosition="left"
          renderNavigationView={() => drawerContent}
        >
          <ThemedView style={styles.containerMobile}>
            <View style={styles.headerBar}>
              <TouchableOpacity onPress={() => drawerRef.current?.openDrawer()} style={styles.hamburger}>
                <Text style={styles.hamburgerText}>☰</Text>
              </TouchableOpacity>
              <Text style={styles.headerTitle}>Chat</Text>
            </View>
            {!hasOmiLink ? (
              <View style={styles.banner}>
                <Text style={styles.bannerText}>Tip: Link your OMI account in Settings to receive live notifications.</Text>
              </View>
            ) : null}
            {!selectedId ? (
              <View style={styles.emptyState}>
                <Text>Select a conversation</Text>
              </View>
            ) : (
              <>
                <FlatList<MessageItem>
                  style={styles.messageList}
                  contentContainerStyle={{ padding: 12 }}
                  data={selectedMessages}
                  renderItem={renderMessage}
                  keyExtractor={(m: MessageItem) => m.id}
                />
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.textInput}
                    placeholder="Type a message or /notify ..."
                    value={input}
                    onChangeText={setInput}
                    multiline
                  />
                  <TouchableOpacity style={styles.sendBtn} onPress={onSend} disabled={sending || !input.trim()}>
                    <Text style={styles.sendBtnText}>{sending ? '...' : 'Send'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ThemedView>
        </DrawerLayoutAndroid>
      ) : (
        <ThemedView style={styles.containerMobile}>
          <View style={styles.headerBar}>
            <TouchableOpacity onPress={() => setShowOverlayList((v: boolean)=>!v)} style={styles.hamburger}>
              <Text style={styles.hamburgerText}>☰</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Chat</Text>
          </View>
          {showOverlayList ? (
            <View style={styles.overlayList}>
              <View style={styles.overlayHeader}><Text style={{ fontWeight: '800' }}>Conversations</Text></View>
              {convos.loading ? <ActivityIndicator /> : (
                <FlatList<ConversationItem>
                  data={convos.items}
                  renderItem={({ item }: { item: ConversationItem }) => (
                    <TouchableOpacity style={[styles.conversationItem, item.id === selectedId && styles.conversationItemActive]} onPress={() => { setSelectedId(item.id); setShowOverlayList(false); }}>
                      <Text style={styles.conversationTitle}>{item.title || 'Untitled'}</Text>
                      {item.summary ? <Text style={styles.conversationSummary} numberOfLines={1}>{item.summary}</Text> : null}
                    </TouchableOpacity>
                  )}
                  keyExtractor={(c: ConversationItem) => c.id}
                />
              )}
            </View>
          ) : null}
          {!hasOmiLink ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>Tip: Link your OMI account in Settings to receive live notifications.</Text>
            </View>
          ) : null}
          {!selectedId ? (
            <View style={styles.emptyState}>
              <Text>Select a conversation</Text>
            </View>
          ) : (
            <>
              <FlatList<MessageItem>
                style={styles.messageList}
                contentContainerStyle={{ padding: 12 }}
                data={selectedMessages}
                renderItem={renderMessage}
                keyExtractor={(m: MessageItem) => m.id}
              />
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.textInput}
                  placeholder="Type a message or /notify ..."
                  value={input}
                  onChangeText={setInput}
                  multiline
                />
                <TouchableOpacity style={styles.sendBtn} onPress={onSend} disabled={sending || !input.trim()}>
                  <Text style={styles.sendBtnText}>{sending ? '...' : 'Send'}</Text>
                </TouchableOpacity>
                {selectedId ? (
                  <TouchableOpacity style={styles.deleteBtn} onPress={async ()=>{ const ok = await apiDeleteConversation(selectedId); if (ok) { setConvos((prev: ConversationState)=>({ ...prev, items: prev.items.filter((i: ConversationItem)=>i.id!==selectedId) })); setSelectedId(null);} }}>
                    <Text style={styles.deleteBtnText}>Delete</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </>
          )}
        </ThemedView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row' },
  containerMobile: { flex: 1 },
  sidebar: { width: 240, borderRightWidth: 1, borderRightColor: '#eee', padding: 12, gap: 12 },
  sidebarHeader: { paddingBottom: 8 },
  conversationItem: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
  conversationItemActive: { backgroundColor: '#f2f2f2' },
  conversationTitle: { fontWeight: '700' },
  conversationSummary: { color: '#666' },
  chatArea: { flex: 1, paddingTop: 12 },
  headerBar: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  hamburger: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff' },
  hamburgerText: { fontSize: 18 },
  headerTitle: { fontSize: 20, fontWeight: '800', marginLeft: 12 },
  overlayList: { position: 'absolute', left: 12, top: 56, bottom: 12, width: 280, backgroundColor: '#fff', borderWidth: 1, borderColor: '#eee', borderRadius: 12, padding: 8, zIndex: 20 },
  overlayHeader: { paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#eee', marginBottom: 6 },
  banner: { marginHorizontal: 12, marginBottom: 8, padding: 10, backgroundColor: '#fff7e6', borderColor: '#ffd591', borderWidth: 1, borderRadius: 8 },
  bannerText: { color: '#8c6d1f' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList: { flex: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: '#eee' },
  textInput: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  sendBtn: { backgroundColor: '#007bff', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  sendBtnText: { color: '#fff', fontWeight: '700' },
  deleteBtn: { backgroundColor: '#ff4d4f', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, marginLeft: 6 },
  deleteBtnText: { color: '#fff', fontWeight: '700' },
  bubbleRow: { width: '100%', marginVertical: 4, paddingHorizontal: 8 },
  left: { alignItems: 'flex-start' },
  right: { alignItems: 'flex-end' },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  assistantBubble: { backgroundColor: '#f0f0f0', borderTopLeftRadius: 2 },
  userBubble: { backgroundColor: '#007bff', borderTopRightRadius: 2 },
  assistantText: { color: '#333' },
  userText: { color: '#fff' },
  badge: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: '#ccc', borderRadius: 999 },
  badgeActive: { backgroundColor: '#2f95dc', borderColor: '#2f95dc' },
  badgeText: { color: '#333' },
  badgeTextActive: { color: '#fff' },
});

